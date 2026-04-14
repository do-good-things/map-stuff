import React from 'react';
import { Link } from 'react-router-dom';

export default function LandingPage() {
  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-header">
          <div className="landing-title">ride visualizer</div>
          <div className="landing-subtitle">explore point reyes rides</div>
        </div>

        <div className="event-grid">
          <Link to="/point_reyes" className="event-card">
            <div className="event-card-icon">🌊</div>
            <div className="event-card-title">Point Reyes</div>
            <div className="event-card-sub">coastal rides</div>
            <div className="event-card-meta">Sarah, Alex, John-Marc</div>
            <div className="event-card-arrow">→</div>
          </Link>
        </div>
      </div>
    </div>
  );
}
