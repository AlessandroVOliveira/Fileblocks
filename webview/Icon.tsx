/** A VS Code codicon (https://microsoft.github.io/vscode-codicons/dist/codicon.html). */
export function Icon({ name }: { name: string }) {
  return <i className={`codicon codicon-${name}`} aria-hidden="true" />;
}
