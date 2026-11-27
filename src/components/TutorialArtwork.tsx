import './TutorialArtwork.css';
import welcomeLogo from '../../assets/branding/welcome-logo.png';

export function TutorialBrand() {
  return <span className="tutorial-brand"><img width={28} height={28} src={welcomeLogo} alt="" /><strong>CodeNode</strong></span>;
}

export function TutorialBookIcon() {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5C8 2 3 4 2 5v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Zm0 0v15"/></svg>;
}
