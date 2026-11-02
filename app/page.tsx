import TogetherApp from "./together-app";
import { requireChatGPTUser } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <TogetherApp displayName={user.displayName} />;
}
