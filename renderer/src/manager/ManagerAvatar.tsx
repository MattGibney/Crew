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
    <Avatar className={className}>
      {picture && <AvatarImage src={picture} alt="" />}
      <AvatarFallback>
        <img src={crewMark} alt="" className="size-full object-cover" />
      </AvatarFallback>
    </Avatar>
  );
}
