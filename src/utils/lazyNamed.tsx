import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';

 



export function lazyNamed<M, K extends keyof M>(
  load: () => Promise<M>,
  name: K,
  fallback: ReactNode = null,
): M[K] extends ComponentType<any> ? M[K] : never {
  const Inner = lazy(() => load().then((m) => ({ default: m[name] as unknown as ComponentType<any> })));
  const Wrapped = (props: any) => (
    <Suspense fallback={fallback}>
      <Inner {...props} />
    </Suspense>
  );
  return Wrapped as any;
}
