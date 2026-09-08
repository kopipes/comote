export function withoutComoteEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("COMOTE_")),
  );
}
