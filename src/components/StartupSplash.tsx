import './startupSplash.css';

export default function StartupSplash({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="startup-splash" role="status" aria-label="正在启动 CodeNode" onAnimationEnd={event => {
      if (event.target === event.currentTarget) onFinish();
    }}>
      <div className="startup-mark" aria-hidden="true">
        <svg className="startup-outline" viewBox="0 0 500 500" fill="none">
          <path pathLength="1" d="M104 448V236a156 156 0 0 1 312 0v-12" />
        </svg>
        <div className="startup-sector" />
        <div className="startup-pointer" />
      </div>
    </div>
  );
}
