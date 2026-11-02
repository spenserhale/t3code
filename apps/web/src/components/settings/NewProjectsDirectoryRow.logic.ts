/** Why a typed folder cannot be saved, or null. Empty is fine: it means the default folder. */
export function newProjectsDirectoryProblem(value: string): string | null {
  const text = value.trim();
  // Either platform's absolute forms: the environments in scope may not share one.
  return text === "" || /^(~([\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(text)
    ? null
    : 'Use an absolute path, or one starting with "~/".';
}
