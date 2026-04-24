import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, resolveAppBootstrapFromLocation } from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App {...resolveAppBootstrapFromLocation(window.location.search)} />
  </StrictMode>,
);
