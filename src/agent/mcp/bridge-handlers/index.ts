import { createCommentHandlers } from "./comment-handlers";
import { createCreationHandlers } from "./creation-handlers";
import { createMutationHandlers } from "./mutation-handlers";
import { createPageHandlers } from "./page-handlers";
import { createReadHandlers } from "./read-handlers";
import type { RendererHandlerContext, RendererHandlerMap } from "./types";
import { createVisualHandlers } from "./visual-handlers";

export function createRendererHandlers(context: RendererHandlerContext) {
  return {
    ...createReadHandlers(context),
    ...createVisualHandlers(context),
    ...createPageHandlers(context),
    ...createCreationHandlers(context),
    ...createMutationHandlers(context),
    ...createCommentHandlers(context),
  } as const satisfies RendererHandlerMap;
}

export type RendererMcpMethod = keyof ReturnType<typeof createRendererHandlers>;

export async function dispatchRendererMcpCall(
  handlers: ReturnType<typeof createRendererHandlers>,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const handler = handlers[method as RendererMcpMethod];
  if (!handler) throw new Error(`Unknown method: ${method}`);
  return handler(params);
}
