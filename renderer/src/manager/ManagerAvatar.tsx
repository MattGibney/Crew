import type { ProfileIdentity } from "./profile.js";
import { useState } from "react";
import crewMark from "../../../build/crew-mark.png";
import { managerPicture } from "./profile.js";

export function ManagerAvatar({
  profile,
  className = "",
}: {
  profile?: ProfileIdentity | null;
  className?: string;
}) {
  const picture = managerPicture(profile);
  const [failed, setFailed] = useState<string | null>(null);
  const source = picture && failed !== picture ? picture : crewMark;
  return (
    <img
      src={source}
      alt=""
      className={`shrink-0 object-cover ${source === crewMark ? "" : "rounded-full"} ${className}`}
      onError={() => setFailed(source)}
    />
  );
}
