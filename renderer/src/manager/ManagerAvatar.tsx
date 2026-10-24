import type { ProfileIdentity } from "./profile.js";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
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
  return (
    <Avatar className={`rounded-[25%] after:rounded-[25%] ${className}`}>
      {picture && <AvatarImage src={picture} alt="" className="rounded-[25%]" />}
      <AvatarFallback className="overflow-hidden rounded-[25%]">
        <img src={crewMark} alt="" className="size-full object-cover" />
      </AvatarFallback>
    </Avatar>
  );
}
