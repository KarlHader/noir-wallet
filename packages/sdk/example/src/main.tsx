import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { PublicDemoApp } from './PublicDemoApp'
import './index.css'

function ExampleEntry() {
  const [hash, setHash] = React.useState(() => window.location.hash)
  React.useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return hash === '#noir-public' ? <PublicDemoApp /> : <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ExampleEntry />
  </React.StrictMode>
)
