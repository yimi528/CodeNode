import { useEffect, useRef, useState, type ReactNode } from 'react';

export default function SettingsDisclosure({ title, initialOpen = false, hint, children }: {
  title: string; initialOpen?: boolean; hint?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [visited, setVisited] = useState(initialOpen);
  useEffect(() => {
    if (initialOpen) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [initialOpen]);
  return <details ref={ref} className="settings-disclosure" open={initialOpen}
    onToggle={event => { if (event.currentTarget.open) setVisited(true); }}>
    <summary>{title}{hint && <small>{hint}</small>}</summary>
    {visited && children}
  </details>;
}
