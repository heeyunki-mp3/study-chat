import gtLogo from "./assets/gt-logo.svg";

export default function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <img src={gtLogo} alt="Georgia Institute of Technology" className="site-header-logo" />
        <span className="site-header-divider" aria-hidden="true" />
        <span className="site-header-title">Focus Group</span>
      </div>
    </header>
  );
}
