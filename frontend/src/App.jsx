import React from 'react';
import { Routes, Route } from 'react-router-dom';
import LandingPage from './LandingPage';
import PointReyesPage from './PointReyesPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/point_reyes" element={<PointReyesPage />} />
    </Routes>
  );
}
