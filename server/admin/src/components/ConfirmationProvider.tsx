import { createContext, useContext, useState, type ReactNode } from 'react'

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'

type Confirm = (title: string, description: string, action: string, destructive?: boolean) => Promise<boolean>
type Confirmation = {
  title: string
  description: string
  action: string
  destructive: boolean
  resolve: (confirmed: boolean) => void
}

const ConfirmationContext = createContext<Confirm>(async () => false)

export function useConfirmation() {
  return useContext(ConfirmationContext)
}

export default function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Confirmation | null>(null)

  function finish(confirmed: boolean) {
    request?.resolve(confirmed)
    setRequest(null)
  }

  const confirm: Confirm = (title, description, action, destructive = true) => new Promise((resolve) => {
    setRequest({ title, description, action, destructive, resolve })
  })

  return <ConfirmationContext.Provider value={confirm}>
    {children}
    <AlertDialog open={request !== null} onOpenChange={(open) => { if (!open) finish(false) }}>
      {request && <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          <AlertDialogDescription>{request.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction className={request.destructive ? buttonVariants({ variant: 'destructive' }) : undefined}
            onClick={() => finish(true)}>{request.action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
  </ConfirmationContext.Provider>
}
