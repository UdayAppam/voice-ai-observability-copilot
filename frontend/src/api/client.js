import axios from 'axios'

const client = axios.create({
  // The SPA is served by the backend at /dashboard (same origin), so the
  // default /api works in production without CORS. VITE_API_BASE_URL is only
  // used in Vite dev mode to point at a separately-running backend.
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': import.meta.env.VITE_API_KEY || '',
  },
})

// Normalise all API errors to { code, message } shape
client.interceptors.response.use(
  (res) => res,
  (err) => {
    const error = err.response?.data?.error || {
      code: 'NETWORK_ERROR',
      message: err.message || 'Network request failed',
      status: 0,
    }
    return Promise.reject(error)
  }
)

export default client
