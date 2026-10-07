import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// /platform is the platform owner console (its own sign-in): a separate chunk that business users never download.
const platform = window.location.pathname === '/platform' || window.location.pathname.startsWith('/platform/');
const PlatformApp = lazy(() => import('./platform/PlatformApp.jsx'));
createRoot(document.getElementById('root')).render(platform ? <Suspense fallback={null}><PlatformApp /></Suspense> : <App />);
