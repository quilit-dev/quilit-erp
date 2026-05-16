import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { SettingsProvider } from './hooks/useSettings.jsx'
import { ThemeProvider } from './hooks/useTheme.jsx'
import { LocaleProvider } from './hooks/useLocale.jsx'

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
