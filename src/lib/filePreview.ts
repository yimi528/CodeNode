export type PreviewContent =
  | { kind: 'text'; content: string; encoding: string; truncated: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'pdf'; data: Uint8Array; office?: boolean; cellText?: { content: string; truncated: boolean } }
  | { kind: 'document'; content: string; truncated: boolean; reason: string };
