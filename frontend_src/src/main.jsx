import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { SettingsProvider } from './hooks/useSettings.jsx'
import { ThemeProvider } from './hooks/useTheme.jsx'
import { LocaleProvider } from './hooks/useLocale.jsx'
import { applyTenantFavicon } from './utils/appIdentity.js'

// Outside React on purpose: the tab icon belongs to the document, and every
// entry point needs it — the login screen and the share page a customer opens
// have no session and never mount the settings provider.
applyTenantFavicon()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <LocaleProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </LocaleProvider>
    </ThemeProvider>
  </StrictMode>,
)
