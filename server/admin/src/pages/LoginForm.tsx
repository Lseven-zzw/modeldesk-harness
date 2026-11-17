import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginForm({ next, csrf, error }: { next: string; csrf: string; error: string }) {
  const [showPassword, setShowPassword] = useState(false)
  return <form method="post" action="/admin/login" className="flex flex-col gap-5">
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <input type="hidden" name="next" value={next} />
    <input type="hidden" name="csrf" value={csrf} />
    <div className="flex flex-col gap-2">
      <Label htmlFor="login-username">账号</Label>
      <Input id="login-username" name="username" autoComplete="username" className="h-11 text-base" required />
    </div>
    <div className="flex flex-col gap-2">
      <Label htmlFor="login-password">密码</Label>
      <div className="relative">
        <Input id="login-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password"
          className="h-11 pr-12 text-base" required />
        <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1"
          aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>
          {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
      </div>
    </div>
    <Button size="lg" type="submit">登录</Button>
  </form>
}
