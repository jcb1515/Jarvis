import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';
import { initApiBase } from './lib/api';
import { initAnalytics } from './lib/analytics';
import './index.css';

function applyTheme() {
  try {
    const raw = localStorage.getItem('openjarvis-settings');
    const settings = raw ? JSON.parse(raw) : {};
    const theme = settings.theme || 'system';
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
    } else if (theme === 'light') {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
    }
  } catch { /* use system default */ }
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

async function registerBrowserPwa(): Promise<void> {
  if (isTauriRuntime() || !('serviceWorker' in navigator)) {
    return;
  }
  const { registerSW } = await import('virtual:pwa-register');
  registerSW({ immediate: true });
}

async function removeLegacyTauriServiceWorkers(): Promise<boolean> {
  if (!isTauriRuntime() || !('serviceWorker' in navigator)) {
    return false;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  const results = await Promise.all(
    registrations.map((registration) => registration.unregister()),
  );
  return results.some((removed) => removed);
}

applyTheme();
void registerBrowserPwa();

async function startApplication(): Promise<void> {
  const removedLegacyServiceWorker = await removeLegacyTauriServiceWorkers();
  if (removedLegacyServiceWorker) {
    window.location.reload();
    return;
  }

  // Fetch the API base URL from the Tauri backend before rendering.
  // This ensures JARVIS_PORT is defined in one place (the Rust backend).
  // In non-Tauri environments this is a no-op.
  try {
    await initApiBase();
  } catch (error: unknown) {
    console.error('Astrono Jarvis could not initialize the desktop API base.', { error });
  }

  // Kick off analytics init in the background — it's never awaited so
  // a slow/failed identity fetch never delays UI render.
  void initAnalytics();

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </StrictMode>,
  );
}

void startApplication();
