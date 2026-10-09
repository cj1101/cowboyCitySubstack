import { getFactionBySlug, getFactionMembers } from "@/lib/firestore/factions";
import { notify, notifyMany } from "@/lib/firestore/notifications";
import { getPost } from "@/lib/firestore/posts";
import { parseMentions } from "@/lib/mentions";

export async function fanOutNewPost(input: {
  id: string;
  title: string;
  body: string;
  factionId: string;
  cityIds: string[];
  referencedPostIds: string[];
  authorUid: string;
}): Promise<void> {
  const href = `/posts/${input.id}`;
  for (const postId of input.referencedPostIds) {
    const target = await getPost(postId);
    if (!target?.authorUid) continue;
    await notify({
      recipientUid: target.authorUid,
      actorUid: input.authorUid,
      type: "reference",
      summary: `“${input.title}” references your post`,
      href,
    }).catch(() => undefined);
  }

  for (const cityId of input.cityIds) {
    if (cityId === input.factionId) continue;
    const members = await getFactionMembers(cityId);
    await notifyMany(
      members.filter((member) => member.role === "owner").map((member) => member.uid),
      {
        actorUid: input.authorUid,
        type: "mention",
        summary: `Your city was tagged in “${input.title}”`,
        href,
      }
    );
  }

  const mentions = parseMentions(input.body);
  for (const slug of mentions.factions) {
    const faction = await getFactionBySlug(slug);
    if (!faction || faction.id === input.factionId) continue;
    const members = await getFactionMembers(faction.id);
    await notifyMany(
      members.filter((member) => member.role === "owner").map((member) => member.uid),
      {
        actorUid: input.authorUid,
        type: "mention",
        summary: `@${faction.name} mentioned in “${input.title}”`,
        href,
      }
    );
  }
}
