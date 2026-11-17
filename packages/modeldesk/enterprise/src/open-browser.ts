/**
 * Hand a validated HTTPS URL to the platform's default browser. Arguments are
 * passed without a shell, so nothing in the URL can become a command.
 * @module @modeldesk/dsh-enterprise/open-browser
 */
import { spawn } from 'node:child_process'

/**
 * Open one URL in the system browser, best-effort.
 * @param url - a URL already validated against the saved origin.
 */
export async function openBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]]
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false })
    child.once('error', () => { resolve() })
    child.once('exit', () => { resolve() })
  })
}
