import type { Dimensions, Node, Edge } from '@xyflow/react';
import type { PlanItem } from '../store/sessionStore';
import { useGraphStore } from '../store/graphStore';
import { useSessionStore } from '../store/sessionStore';

type Step = { key:string; title:string; objective:string; acceptance:string; dependsOn:string[]; writeScope?:string[] };

/** Add one planning proposal as editable canvas nodes in a single undo step. */
export function addPlanToCanvas(steps:Step[],sourceId:string): number {
  if(!steps.length)return 0;
  const store=useGraphStore.getState(),existing=new Set(store.nodes.map(node=>node.id));
  if(store.nodes.some(node=>node.data.planSourceId===sourceId))return 0;
  const prefix=`plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
  const ids=new Map(steps.map((step,index)=>[step.key,`${prefix}-${index+1}`]));
  const positions=new Map<string,number>();const byKey=new Map(steps.map(step=>[step.key,step]));
  const level=(key:string,seen=new Set<string>()):number=>{if(seen.has(key))return 0;seen.add(key);const deps=byKey.get(key)?.dependsOn||[];return deps.length?1+Math.max(...deps.filter(dep=>ids.has(dep)).map(dep=>level(dep,new Set(seen)))):0;};
  const nodes:Node[]=steps.map((step,index)=>{const x=level(step.key),row=positions.get(String(x))||0;positions.set(String(x),row+1);return{id:ids.get(step.key)!,type:'task',position:{x:60+x*245,y:100+row*165},data:{label:step.title||`步骤 ${index+1}`,prompt:step.objective,completionCondition:step.acceptance,writeScope:(step.writeScope||[]).join(', '),status:'pending',accent:'#3b82f6',planSourceId:sourceId}};});
  const edges:Edge[]=[];
  steps.forEach((step,index)=>{
    const deps=step.dependsOn.length?step.dependsOn:(index>0?[steps[index-1].key]:[]);
    for(const dep of deps){const source=ids.get(dep),target=ids.get(step.key);if(source&&target&&source!==target)edges.push({id:`${source}:${target}`,source,target,type:'waypoint'});}
  });
  if(nodes.some(node=>existing.has(node.id)))throw new Error('画布节点编号发生冲突，请重试');
  store.commit();
  useGraphStore.setState(state=>({nodes:[...state.nodes,...nodes],edges:[...state.edges,...edges],selectedId:nodes[0].id,selectedIds:[nodes[0].id]}));
  useGraphStore.getState().runFlow();
  useSessionStore.getState().syncActiveGraph();
  return nodes.length;
}

/** Display the current Agent plan without changing the executable workflow document. */
export function projectPlanOnCanvas(
  items: PlanItem[] | null, sourceId: string | null, nodes: Node[], edges: Edge[],
  previewSizes?: Record<string, Dimensions>,
) {
  if (!items?.length || !sourceId) return { nodes, edges, previewIds: new Set<string>() };

  const byItem = new Map(items.map((item) => [item.id, item]));
  const existing = nodes.filter((node) => node.data.planSourceId === sourceId);
  const ids = new Map<string, string>();
  const previews = new Map<string, PlanItem>();
  const previewIds = new Set<string>();
  const generated: Node[] = [];
  const bottom = nodes.reduce((value, node) => Math.max(value,
    node.position.y + (node.measured?.height || Number(node.data.height) || (node.type === 'vector' ? 640 : 140))), 40);
  const nextY = new Map<number, number>();
  const depths = new Map<string, number>();
  const hasDependencies = items.some((item) => item.dependsOn?.length);
  const depth = (id: string, visited = new Set<string>()): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visited.has(id)) return 0;
    const deps = (byItem.get(id)?.dependsOn || []).filter((dep) => byItem.has(dep));
    visited.add(id);
    const value = deps.length ? 1 + Math.max(...deps.map((dep) => depth(dep, visited))) : 0;
    visited.delete(id);
    depths.set(id, value);
    return value;
  };

  items.forEach((item, index) => {
    const legacy = existing.find((node) => !previews.has(node.id) &&
      (node.data.prompt === item.step || node.data.label === item.step.slice(0, 80)));
    if (legacy) {
      ids.set(item.id, legacy.id);
      previews.set(legacy.id, item);
      return;
    }
    const id = `agent-plan:${sourceId}:${item.id}`;
    const column = hasDependencies ? depth(item.id) : index % 4;
    const measured = previewSizes?.[id];
    const y = nextY.get(column) ?? bottom + 60;
    nextY.set(column, y + (measured?.height ?? 104) + 28);
    ids.set(item.id, id);
    previewIds.add(id);
    generated.push({
      id, type: 'task', position: { x: 60 + column * 245, y }, measured,
      width: 210, initialHeight: 104, draggable: false, selectable: false, connectable: false, deletable: false, focusable: false,
      data: { label: item.step || `步骤 ${index + 1}`, planPreview: item, planPreviewOnly: true },
    });
  });

  const connections = new Set(edges.map((edge) => `${edge.source}\n${edge.target}`));
  const planEdges = items.flatMap((item) => {
    const target = ids.get(item.id)!;
    return (item.dependsOn || []).flatMap((dep): Edge[] => {
      const source = ids.get(dep);
      if (!source || source === target || connections.has(`${source}\n${target}`)) return [];
      return [{ id: `${source}->${target}`, source, target, type: 'waypoint', selectable: false, deletable: false, focusable: false, interactionWidth: 0 }];
    });
  });
  return {
    nodes: [...nodes.map((node) => previews.has(node.id) ? { ...node, data: { ...node.data, planPreview: previews.get(node.id) } } : node), ...generated],
    edges: [...edges, ...planEdges],
    previewIds,
  };
}
