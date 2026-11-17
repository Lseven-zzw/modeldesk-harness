import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'
import LoginForm from './pages/LoginForm'
import './index.css'

const login = document.getElementById('admin-login-form')
const root = login ?? document.getElementById('root')

if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {login ? <LoginForm next={login.dataset.next ?? '/admin/'}
        csrf={login.dataset.csrf ?? ''} error={login.dataset.error ?? ''} /> : <App />}
    </React.StrictMode>,
  )
}
