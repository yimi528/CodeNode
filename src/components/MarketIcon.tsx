const paths = {
  search: 'M20 20l-5.2-5.2 M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
  branch: 'M7 8v9m0-3c7 0 10-2 10-6 M9.5 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z M9.5 19a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z M19.5 6a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  history: 'M11 6h9m-9 6h9m-9 6h9 M6.5 6a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z M6.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z M6.5 18a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8.5 13h7m-7 4h5',
  chevron: 'm7 10 5 5 5-5',
} as const;

export default function MarketIcon({name}: {name: keyof typeof paths}) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
