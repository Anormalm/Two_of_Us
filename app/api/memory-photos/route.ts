import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getDb } from "../../../db";
import { memories, memoryPhotos } from "../../../db/schema";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const maxFileSize = 8 * 1024 * 1024;
const maxBatchSize = 9;

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (!env.BUCKET) return Response.json({ error: "照片存储不可用" }, { status: 503 });
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return Response.json({ error: "无效照片" }, { status: 400 });
  const db = getDb();
  const [photo] = await db.select().from(memoryPhotos).where(eq(memoryPhotos.id, id)).limit(1);
  if (!photo) return Response.json({ error: "照片不存在" }, { status: 404 });
  const object = await env.BUCKET.get(photo.objectKey);
  if (!object) return Response.json({ error: "照片不存在" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, max-age=86400",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(photo.fileName)}`,
    },
  });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (!env.BUCKET) return Response.json({ error: "照片存储不可用" }, { status: 503 });
  const form = await request.formData();
  const memoryId = Number(form.get("memoryId"));
  const files = form.getAll("photos").filter((value): value is File => value instanceof File && value.size > 0);
  if (!Number.isInteger(memoryId)) return Response.json({ error: "无效记录" }, { status: 400 });
  if (!files.length || files.length > maxBatchSize) return Response.json({ error: "每次请选择 1 到 9 张照片" }, { status: 400 });
  for (const file of files) {
    if (!allowedTypes.has(file.type)) return Response.json({ error: "仅支持 JPG、PNG、WebP 和 HEIC" }, { status: 400 });
    if (file.size > maxFileSize) return Response.json({ error: "单张照片不能超过 8 MB" }, { status: 400 });
  }
  const db = getDb();
  const [memory] = await db.select().from(memories).where(eq(memories.id, memoryId)).limit(1);
  if (!memory) return Response.json({ error: "记录不存在" }, { status: 404 });

  const saved = [];
  for (const file of files) {
    const suffix = file.name.includes(".") ? file.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() : "jpg";
    const objectKey = `memories/${memoryId}/${crypto.randomUUID()}.${suffix || "jpg"}`;
    await env.BUCKET.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } });
    try {
      const [photo] = await db.insert(memoryPhotos).values({
        memoryId,
        objectKey,
        fileName: file.name.slice(0, 180) || "photo",
        contentType: file.type,
        uploadedBy: user.userId,
      }).returning();
      saved.push(photo);
    } catch (error) {
      await env.BUCKET.delete(objectKey);
      throw error;
    }
  }
  return Response.json({ photos: saved }, { status: 201 });
}

export async function DELETE(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (!env.BUCKET) return Response.json({ error: "照片存储不可用" }, { status: 503 });
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id)) return Response.json({ error: "无效照片" }, { status: 400 });
  const db = getDb();
  const [photo] = await db.select().from(memoryPhotos).where(eq(memoryPhotos.id, id)).limit(1);
  if (!photo) return Response.json({ error: "照片不存在" }, { status: 404 });
  await env.BUCKET.delete(photo.objectKey);
  await db.delete(memoryPhotos).where(eq(memoryPhotos.id, id));
  return Response.json({ deleted: true });
}
