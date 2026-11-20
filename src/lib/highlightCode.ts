function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function highlightCode(value: string) {
  const token = /(\/\/[^\n]*|#[^\n]*|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|export|async|await|new|true|false|null|undefined|try|catch|throw|interface|type|public|private|static|void|boolean|string|number)\b|\b\d+(?:\.\d+)?\b)/g;
  let result = '';
  let last = 0;
  value.replace(token, (match, _unused, offset) => {
    result += escapeHtml(value.slice(last, offset));
    const cls = /^(\/\/|#)/.test(match) ? 'comment' : /^("|'|`)/.test(match) ? 'string' : /^\d/.test(match) ? 'number' : 'keyword';
    result += `<span class="tok-${cls}">${escapeHtml(match)}</span>`;
    last = offset + match.length;
    return match;
  });
  return result + escapeHtml(value.slice(last));
}
