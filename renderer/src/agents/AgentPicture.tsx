import { useEffect, useState } from "react";
import type { AgentsClient } from "./client";
import { ManagerAvatar } from "../manager/ManagerAvatar";
import { managerPicture } from "../manager/profile";

export type AgentImageClient = Pick<AgentsClient, "readImage" | "saveImage">;

// References are immutable and the cache is scoped to the selected project client.
const pictures = new WeakMap<
  AgentImageClient,
  Map<string, Promise<string | null>>
>();
export function useAgentPicture(
  client: AgentImageClient,
  imageRef: string | null | undefined,
) {
  const [loaded, setLoaded] = useState<{
    client: AgentImageClient;
    ref: string;
    picture: string | null;
  } | null>(null);
  useEffect(() => {
    if (!imageRef || !client.readImage) return;
    let active = true;
    let cache = pictures.get(client);
    if (!cache) {
      cache = new Map();
      pictures.set(client, cache);
    }
    let request = cache.get(imageRef);
    if (!request) {
      request = client
        .readImage(imageRef)
        .then((result) => managerPicture(result))
        .catch(() => {
          cache!.delete(imageRef);
          return null;
        });
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      cache.set(imageRef, request);
    }
    void request.then((picture) => {
      if (active) setLoaded({ client, ref: imageRef, picture });
    });
    return () => {
      active = false;
    };
  }, [client, imageRef]);
  return loaded?.client === client && loaded.ref === imageRef
    ? loaded.picture
    : null;
}

export function AgentPicture({
  client,
  imageRef,
  picture,
  className,
}: {
  client: AgentImageClient;
  imageRef?: string | null;
  /** A local draft, including explicit removal, overrides the saved reference. */
  picture?: string | null;
  className?: string;
}) {
  const saved = useAgentPicture(client, imageRef);
  return (
    <ManagerAvatar
      profile={{ picture: picture === undefined ? saved : picture }}
      className={className}
    />
  );
}
