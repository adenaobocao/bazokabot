import { createContext, useContext } from 'react'
import { SessionState } from './session'

interface SessionCtx {
  session: SessionState | null
  setSession: (s: SessionState | null) => void
}

export const SessionContext = createContext<SessionCtx>({
  session: null,
  setSession: () => {},
})

export const useSession = () => useContext(SessionContext)
