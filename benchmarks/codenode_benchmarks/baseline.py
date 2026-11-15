"""Pinned Terminus-2 with explicit resource ceilings; its solver/prompt stay native."""
from __future__ import annotations
import asyncio
import inspect
import json
from pathlib import Path

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.agents.terminus_2.terminus_2 import Terminus2, Terminus2Options


class ComparisonStop(BaseException):
    """Stop without the reference agent's generic exception retries."""


def estimate_text_input(messages):
    # Text-only equivalent of electron/requestBudget.cjs estimateInputTokens.
    payload=json.dumps({'messages':messages,'tools':[]},ensure_ascii=False,separators=(',',':'))
    return len(payload.encode('utf8'))+len(messages)*32+256


class CallBudget:
    def __init__(self,limit=600000,max_calls=60):
        self.limit=int(limit);self.max_calls=int(max_calls)
        self.used=0;self.reserved=0;self.requests=[]

    def reserve(self,messages,requested=32000):
        need=estimate_text_input(messages)
        output=min(int(requested),self.limit-self.used-self.reserved-need)
        if len(self.requests)>=self.max_calls or output<1:
            raise ComparisonStop('comparison request/token budget exhausted before sending')
        entry={'input_reservation':need,'max_output_tokens':output,'settled':False}
        self.requests.append(entry);self.reserved+=need+output
        return entry

    def settle(self,entry,usage=None,error=None):
        if entry['settled']:return
        reserved=entry['input_reservation']+entry['max_output_tokens']
        actual=(usage.prompt_tokens+usage.completion_tokens) if usage else reserved
        self.reserved-=reserved;self.used+=actual
        entry.update(settled=True,charged_tokens=actual,usage_known=usage is not None,error_type=error)

    def snapshot(self):
        return {'limit':self.limit,'max_calls':self.max_calls,'used':self.used,
                'reserved':self.reserved,'requests':self.requests}


class ComparisonOptions(Terminus2Options):
    max_total_tokens: int = 600000
    max_commands: int = 100
    turn_timeout: int = 300


class BudgetedTerminus2(Terminus2):
    options_model=ComparisonOptions
    def __init__(self,*args,max_total_tokens=600000,max_commands=100,turn_timeout=300,**kwargs):
        kwargs.setdefault('max_turns',60)
        kwargs.setdefault('record_terminal_session',False)
        kwargs.setdefault('model_info',{'max_input_tokens':1000000,'max_output_tokens':32000})
        super().__init__(*args,max_total_tokens=max_total_tokens,max_commands=max_commands,
                         turn_timeout=turn_timeout,**kwargs)
        # max_turns bounds the reference solver loop; compaction model calls
        # consume the same token account without an extra, asymmetric turn cap.
        self.call_budget=CallBudget(max_total_tokens,1000000)
        self.max_commands=int(max_commands);self.command_count=0
        self.turn_timeout=int(turn_timeout)
        # Bypass only LiteLLM's transport retry decorator. Reference planning,
        # terminal parser, completion confirmation and compaction are unchanged.
        raw=inspect.unwrap(type(self._llm).call)
        self._llm.call=lambda *a,**k:self._bounded_call(raw,*a,**k)

    def _save_budget(self):
        self.logs_dir.mkdir(parents=True,exist_ok=True)
        (self.logs_dir/'comparison-budget.json').write_text(json.dumps({
            **self.call_budget.snapshot(),'commands':self.command_count,
            'max_commands':self.max_commands,'turn_timeout':self.turn_timeout},indent=2))

    async def _bounded_call(self,raw,prompt,message_history=None,**kwargs):
        history=[m.model_dump(exclude_none=True) if hasattr(m,'model_dump') else m for m in (message_history or [])]
        messages=history+[{'role':'user','content':prompt}]
        if kwargs.get('response_format') is not None:
            raise ComparisonStop('Unexpected structured transport changes budget input; review before inference')
        entry=self.call_budget.reserve(messages,kwargs.pop('max_tokens',32000))
        self._save_budget()
        # The native ATIF trajectory retains prompts/actions. Omit provider debug
        # dumps, which can contain SDK credential arguments nested in metadata.
        kwargs.update(logging_path=None,max_tokens=entry['max_output_tokens'],
                      timeout=self.turn_timeout,num_retries=0)
        try:
            response=await asyncio.wait_for(raw(self._llm,prompt,message_history=history,**kwargs),self.turn_timeout)
        except asyncio.TimeoutError:
            self.call_budget.settle(entry,error='request_timeout');self._save_budget()
            raise ComparisonStop(f'model request exceeded {self.turn_timeout}s') from None
        except BaseException as error:
            self.call_budget.settle(entry,error=type(error).__name__);self._save_budget();raise
        self.call_budget.settle(entry,response.usage);self._save_budget()
        return response

    async def _execute_commands(self,commands,session):
        if self.command_count+len(commands)>self.max_commands:
            raise ComparisonStop('comparison terminal command budget exhausted')
        self.command_count+=len(commands);self._save_budget()
        return await super()._execute_commands(commands,session)

    async def run(self,instruction,environment,context):
        pending=None
        try:
            await super().run(instruction,environment,context)
        except ComparisonStop as error:
            pending=NonZeroAgentExitCodeError(str(error))
        except Exception as error:
            message=str(error)
            if self.model_connection.api_key:
                message=message.replace(self.model_connection.api_key,'[REDACTED]')
            pending=NonZeroAgentExitCodeError(type(error).__name__+': '+message)
        finally:
            self._save_budget()
            # Same pre-verifier patch capture as CodeNode, including new files.
            cwd=await environment.exec('pwd')
            if (cwd.stdout or '').strip()=='/testbed':
                result=await environment.exec("git add -N --all -- . ':!.codenode' && git diff --binary --no-ext-diff HEAD -- . ':!.codenode'",cwd='/testbed',timeout_sec=60)
                if result.return_code:raise RuntimeError('Could not collect reference-agent SWE patch')
                patch=self.logs_dir/'prediction.patch';patch.write_text(result.stdout or '')
                await environment.upload_file(patch,'/logs/agent/prediction.patch')
            budget_file=self.logs_dir/'comparison-budget.json'
            await environment.upload_file(budget_file,'/logs/agent/comparison-budget.json')
        if pending:raise pending
