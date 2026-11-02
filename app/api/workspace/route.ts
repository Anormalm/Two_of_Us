import { and, desc, eq, gte } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "../../../db";
import { habitChecks, habits, ideas, memories, memoryPhotos, profiles, workspaceSettings } from "../../../db/schema";

const categories = new Set(["eat", "buy", "go", "cook", "watch", "other"]);
const statuses = new Set(["idea", "planned", "done"]);

function clean(value: unknown, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function currentUser() {
  const user = await getChatGPTUser();
  if (!user) return null;
  const db = getDb();
  const existing = await db.select().from(profiles).where(eq(profiles.userId, user.userId)).limit(1);
  let initialCustomName: string | null = null;
  if (!existing[0]) {
    const existingPeople = await db.select().from(profiles).limit(1);
    if (existingPeople.length > 0) {
      const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, 1)).limit(1);
      initialCustomName = settings?.pendingPartnerName || null;
    }
  }
  await db.insert(profiles).values({
    userId: user.userId,
    displayName: user.displayName,
    customName: initialCustomName,
    email: user.email,
    updatedAt: new Date().toISOString(),
  }).onConflictDoUpdate({
    target: profiles.userId,
    set: { displayName: user.displayName, email: user.email, updatedAt: new Date().toISOString() },
  });
  return user;
}

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const db = getDb();
  const since = new Date();
  since.setDate(since.getDate() - 45);
  const [people, ideaRows, habitRows, checkRows, memoryRows, photoRows, settingsRows] = await Promise.all([
    db.select().from(profiles),
    db.select().from(ideas).orderBy(desc(ideas.createdAt)),
    db.select().from(habits).orderBy(desc(habits.createdAt)),
    db.select().from(habitChecks).where(gte(habitChecks.day, since.toISOString().slice(0, 10))),
    db.select().from(memories).orderBy(desc(memories.memoryDate), desc(memories.createdAt)),
    db.select({ id: memoryPhotos.id, memoryId: memoryPhotos.memoryId, fileName: memoryPhotos.fileName, contentType: memoryPhotos.contentType, uploadedBy: memoryPhotos.uploadedBy, createdAt: memoryPhotos.createdAt }).from(memoryPhotos).orderBy(memoryPhotos.createdAt),
    db.select().from(workspaceSettings).where(eq(workspaceSettings.id, 1)).limit(1),
  ]);
  return Response.json({ currentUserId: user.userId, people, ideas: ideaRows, habits: habitRows, checks: checkRows, memories: memoryRows, memoryPhotos: photoRows, pendingPartnerName: settingsRows[0]?.pendingPartnerName || "" });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  const payload = (await request.json()) as Record<string, unknown>;
  const action = clean(payload.action, 30);
  const db = getDb();

  if (action === "createIdea") {
    const title = clean(payload.title);
    if (!title) return Response.json({ error: "请写下一个想法" }, { status: 400 });
    const category = clean(payload.category, 20);
    const [item] = await db.insert(ideas).values({
      title,
      category: categories.has(category) ? category : "other",
      note: clean(payload.note, 500),
      status: clean(payload.plannedDate, 10) ? "planned" : "idea",
      plannedDate: clean(payload.plannedDate, 10) || null,
      createdBy: user.userId,
    }).returning();
    return Response.json({ item }, { status: 201 });
  }

  if (action === "updateIdea") {
    const id = Number(payload.id);
    const status = clean(payload.status, 20);
    if (!Number.isInteger(id) || !statuses.has(status)) return Response.json({ error: "无效操作" }, { status: 400 });
    const plannedDate = clean(payload.plannedDate, 10) || null;
    const [item] = await db.update(ideas).set({
      status,
      plannedDate: status === "idea" ? null : plannedDate,
      completedAt: status === "done" ? new Date().toISOString() : null,
    }).where(eq(ideas.id, id)).returning();
    return Response.json({ item });
  }

  if (action === "createHabit") {
    const title = clean(payload.title);
    if (!title) return Response.json({ error: "请填写习惯名称" }, { status: 400 });
    const [habit] = await db.insert(habits).values({ title, cadence: clean(payload.cadence, 40) || "每天", createdBy: user.userId }).returning();
    return Response.json({ habit }, { status: 201 });
  }

  if (action === "toggleHabit") {
    const habitId = Number(payload.habitId);
    const day = clean(payload.day, 10);
    if (!Number.isInteger(habitId) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: "无效日期" }, { status: 400 });
    const existing = await db.select().from(habitChecks).where(and(eq(habitChecks.habitId, habitId), eq(habitChecks.userId, user.userId), eq(habitChecks.day, day))).limit(1);
    if (existing[0]) {
      await db.delete(habitChecks).where(eq(habitChecks.id, existing[0].id));
      return Response.json({ checked: false });
    }
    await db.insert(habitChecks).values({ habitId, userId: user.userId, day });
    return Response.json({ checked: true });
  }

  if (action === "createMemory") {
    const title = clean(payload.title);
    const memoryDate = clean(payload.memoryDate, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(memoryDate)) return Response.json({ error: "请填写标题和日期" }, { status: 400 });
    const sourceIdeaId = payload.sourceIdeaId ? Number(payload.sourceIdeaId) : null;
    const [memory] = await db.insert(memories).values({
      title,
      note: clean(payload.note, 1000),
      memoryDate,
      sourceIdeaId: Number.isInteger(sourceIdeaId) ? sourceIdeaId : null,
      createdBy: user.userId,
    }).returning();
    if (sourceIdeaId) await db.update(ideas).set({ status: "done", completedAt: new Date().toISOString() }).where(eq(ideas.id, sourceIdeaId));
    return Response.json({ memory }, { status: 201 });
  }

  if (action === "updateNames") {
    const myName = clean(payload.myName, 30);
    const partnerName = clean(payload.partnerName, 30);
    if (!myName || !partnerName) return Response.json({ error: "请填写双方名字" }, { status: 400 });
    const allPeople = await db.select().from(profiles);
    const partner = allPeople.find((person) => person.userId !== user.userId);
    await db.update(profiles).set({ customName: myName, updatedAt: new Date().toISOString() }).where(eq(profiles.userId, user.userId));
    if (partner) {
      await db.update(profiles).set({ customName: partnerName, updatedAt: new Date().toISOString() }).where(eq(profiles.userId, partner.userId));
    } else {
      await db.insert(workspaceSettings).values({ id: 1, pendingPartnerName: partnerName, updatedAt: new Date().toISOString() }).onConflictDoUpdate({
        target: workspaceSettings.id,
        set: { pendingPartnerName: partnerName, updatedAt: new Date().toISOString() },
      });
    }
    return Response.json({ saved: true });
  }

  if (action === "deleteIdea") {
    const id = Number(payload.id);
    if (!Number.isInteger(id)) return Response.json({ error: "无效记录" }, { status: 400 });
    await db.delete(ideas).where(eq(ideas.id, id));
    return Response.json({ deleted: true });
  }

  if (action === "deleteHabit") {
    const id = Number(payload.id);
    if (!Number.isInteger(id)) return Response.json({ error: "无效习惯" }, { status: 400 });
    await db.delete(habits).where(eq(habits.id, id));
    return Response.json({ deleted: true });
  }

  if (action === "deleteMemory") {
    const id = Number(payload.id);
    if (!Number.isInteger(id)) return Response.json({ error: "无效记录" }, { status: 400 });
    const photos = await db.select().from(memoryPhotos).where(eq(memoryPhotos.memoryId, id));
    if (env.BUCKET && photos.length) await Promise.all(photos.map((photo) => env.BUCKET!.delete(photo.objectKey)));
    await db.delete(memories).where(eq(memories.id, id));
    return Response.json({ deleted: true });
  }

  return Response.json({ error: "未知操作" }, { status: 400 });
}
