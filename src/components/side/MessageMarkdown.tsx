import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './messageMarkdown.css';

const plugins = [remarkGfm];

const components: Components = {
  a({ href, title, children }) {
    return href && /^https?:\/\//i.test(href)
      ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
      : <>{children}</>;
  },
  img({ alt }) {
    return alt ? <span>{alt}</span> : null;
  },
  table({ children }) {
    return (
      <div className="cs-markdown-table" role="region" aria-label="回答表格" tabIndex={0}>
        <table>{children}</table>
      </div>
    );
  },
};

export default memo(function MessageMarkdown({ text }: { text: string }) {
  return <Markdown remarkPlugins={plugins} components={components} skipHtml>{text}</Markdown>;
});
