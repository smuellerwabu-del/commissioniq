// CommissionIQ – Supabase Edge Function: commissioniq-notify
// Deploy: supabase functions deploy commissioniq-notify
// Set secret: supabase secrets set RESEND_API_KEY=re_xxxx

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "commissioning@commissioniq.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── EMAIL SENDER (via Resend) ─────────────────────────────────────────────────
async function sendEmail(to: string[], subject: string, html: string) {
  if(!RESEND_API_KEY) { console.warn("RESEND_API_KEY not set — email skipped"); return; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if(!res.ok) console.error("Resend error:", await res.text());
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────────
function baseEmail(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><style>
    body{font-family:system-ui,sans-serif;background:#F7F5F0;margin:0;padding:20px}
    .card{background:#fff;border-radius:12px;padding:32px;max-width:560px;margin:0 auto;border:1px solid #DDD8CE}
    .logo{font-size:20px;font-weight:300;color:#1C2B3A;margin-bottom:4px}
    .logo em{font-style:italic;opacity:.6}
    h2{font-size:18px;font-weight:300;color:#1A1F2E;margin:16px 0 8px}
    p{color:#4A5568;font-size:14px;line-height:1.6;margin:0 0 12px}
    .btn{display:inline-block;padding:10px 20px;background:#1C2B3A;color:#fff;border-radius:7px;text-decoration:none;font-size:13px;margin-top:8px}
    .foot{margin-top:20px;font-size:11px;color:#8896A8;border-top:1px solid #DDD8CE;padding-top:12px}
    .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;font-family:monospace}
    .badge-warn{background:#FDF3E3;color:#C17B2F}
    .badge-ok{background:#EDF7F3;color:#2D7A5E}
    .badge-red{background:#FDF0F0;color:#B84040}
  </style></head><body><div class="card">
    <div class="logo">Commission<em>IQ</em></div>
    <h2>${title}</h2>
    ${body}
    <div class="foot">CommissionIQ · Datacenter Commissioning Platform · This is an automated notification.</div>
  </div></body></html>`;
}

// ── GET PROJECT ADMINS & OWNER-REPS ──────────────────────────────────────────
async function getNotifyList(projectId: string, roles: string[]): Promise<string[]> {
  const { data } = await sb.from("project_members")
    .select("user_id, role")
    .eq("project_id", projectId)
    .in("role", roles);
  if(!data?.length) return [];
  const userIds = data.map((m: any) => m.user_id);
  const { data: users } = await sb.from("users").select("email").in("id", userIds);
  return users?.map((u: any) => u.email).filter(Boolean) || [];
}

// ── NOTIFICATION HANDLERS ─────────────────────────────────────────────────────
const handlers: Record<string, (payload: any) => Promise<void>> = {

  async approval_requested({ projectId, requestedBy, cx_level, note }) {
    const { data: project } = await sb.from("projects").select("name,client").eq("id", projectId).single();
    const recipients = await getNotifyList(projectId, ["Admin", "Owner-Rep"]);
    if(!recipients.length) return;
    const levelName = ["Design Review","FAT","Delivery","Pre-Functional","FPT","IST","Handover"][cx_level] || `L${cx_level}`;
    await sendEmail(
      recipients,
      `Approval Requested – L${cx_level} ${levelName} · ${project?.name}`,
      baseEmail(
        `Level ${cx_level} Approval Requested`,
        `<p><strong>${requestedBy}</strong> is requesting approval for <strong>L${cx_level} – ${levelName}</strong> on project <strong>${project?.name}</strong> (${project?.client}).</p>
         ${note ? `<p><em>"${note}"</em></p>` : ""}
         <p>Please log in to CommissionIQ to review the test protocols and approve or reject this level.</p>`
      )
    );
  },

  async approval_responded({ projectId, decision, responderEmail }) {
    const { data: project } = await sb.from("projects").select("name").eq("id", projectId).single();
    const { data: ap } = await sb.from("approvals")
      .select("cx_level, requested_by_email")
      .eq("project_id", projectId)
      .eq("status", decision)
      .order("responded_at", { ascending: false })
      .limit(1)
      .single();
    if(!ap?.requested_by_email) return;
    const levelName = ["Design Review","FAT","Delivery","Pre-Functional","FPT","IST","Handover"][ap.cx_level] || `L${ap.cx_level}`;
    const badge = decision === "approved"
      ? `<span class="badge badge-ok">✓ APPROVED</span>`
      : `<span class="badge badge-red">✗ REJECTED</span>`;
    await sendEmail(
      [ap.requested_by_email],
      `Approval ${decision.toUpperCase()} – L${ap.cx_level} · ${project?.name}`,
      baseEmail(
        `Level ${ap.cx_level} ${levelName} – ${decision.toUpperCase()}`,
        `<p>Your approval request has been ${badge} by <strong>${responderEmail}</strong>.</p>
         <p>Project: <strong>${project?.name}</strong></p>`
      )
    );
  },

  async punch_due({ projectId, itemNumber, description, assignedEmail, dueDate }) {
    if(!assignedEmail) return;
    const { data: project } = await sb.from("projects").select("name").eq("id", projectId).single();
    await sendEmail(
      [assignedEmail],
      `Punch Item Due Tomorrow – ${itemNumber} · ${project?.name}`,
      baseEmail(
        `Punch Item Due Tomorrow`,
        `<p>Punch item <strong>${itemNumber}</strong> is due on <strong>${dueDate}</strong>.</p>
         <p><em>${description}</em></p>
         <p>Project: <strong>${project?.name}</strong></p>
         <p>Please resolve this item or update the due date in CommissionIQ.</p>`
      )
    );
  },

  async test_locked({ projectId, testNumber, signatureName, witnessSignature }) {
    const { data: project } = await sb.from("projects").select("name").eq("id", projectId).single();
    const recipients = await getNotifyList(projectId, ["Admin", "Owner-Rep"]);
    if(!recipients.length) return;
    await sendEmail(
      recipients,
      `Test Signed & Locked – ${testNumber} · ${project?.name}`,
      baseEmail(
        `Test ${testNumber} Signed & Locked`,
        `<p>Test <strong>${testNumber}</strong> has been digitally signed and locked.</p>
         <p>CxA Signature: <strong>${signatureName}</strong></p>
         ${witnessSignature ? `<p>Owner Witness: <strong>${witnessSignature}</strong></p>` : ""}
         <p>Project: <strong>${project?.name}</strong></p>
         <p>This record is now immutable and has been recorded in the audit trail.</p>`
      )
    );
  },

  async member_added({ projectId, email, role }) {
    const { data: project } = await sb.from("projects").select("name, client").eq("id", projectId).single();
    await sendEmail(
      [email],
      `You've been added to ${project?.name} on CommissionIQ`,
      baseEmail(
        `Welcome to ${project?.name}`,
        `<p>You have been added to the commissioning project <strong>${project?.name}</strong> (${project?.client}) as <strong>${role}</strong>.</p>
         <p>You can now log in to CommissionIQ to view project data${role !== "Viewer" ? ", record tests, and manage punch items" : ""}.</p>
         <p>If you haven't set up your account yet, you'll receive a separate invitation email.</p>`
      )
    );
  },

  async critical_punch({ projectId, itemNumber, description, severity }) {
    const { data: project } = await sb.from("projects").select("name").eq("id", projectId).single();
    const recipients = await getNotifyList(projectId, ["Admin", "CxA"]);
    if(!recipients.length) return;
    await sendEmail(
      recipients,
      `⚠ Critical Punch Item Created – ${itemNumber} · ${project?.name}`,
      baseEmail(
        `Critical Punch Item: ${itemNumber}`,
        `<p><span class="badge badge-red">CRITICAL</span></p>
         <p>A critical punch item has been created on project <strong>${project?.name}</strong>:</p>
         <p><em>${description}</em></p>
         <p>Please review and assign this item immediately in CommissionIQ.</p>`
      )
    );
  },

  async document_analyzed({ projectId, fileName, valuesCount, uploaderEmail }) {
    if(!uploaderEmail) return;
    const { data: project } = await sb.from("projects").select("name").eq("id", projectId).single();
    await sendEmail(
      [uploaderEmail],
      `AI Analysis Complete – ${fileName} · ${project?.name}`,
      baseEmail(
        `Document Analysis Complete`,
        `<p>The AI analysis of <strong>${fileName}</strong> is complete.</p>
         <p><strong>${valuesCount}</strong> technical value${valuesCount !== 1 ? "s" : ""} extracted.</p>
         <p>Log in to CommissionIQ to review and accept the extracted values.</p>
         <p>Project: <strong>${project?.name}</strong></p>`
      )
    );
  },
};

// ── SCHEDULED: Check punch items due tomorrow ────────────────────────────────
async function checkDuePunchItems() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dueDate = tomorrow.toISOString().slice(0, 10);
  const { data: items } = await sb.from("punch_items")
    .select("*, projects(name)")
    .eq("due_date", dueDate)
    .eq("status", "open");
  for(const item of items || []) {
    if(item.assigned_to_name) {
      // Look up email from users table
      const { data: u } = await sb.from("users").select("email").eq("full_name", item.assigned_to_name).limit(1);
      if(u?.[0]?.email) {
        await handlers.punch_due({
          projectId: item.project_id,
          itemNumber: item.item_number,
          description: item.description,
          assignedEmail: u[0].email,
          dueDate,
        });
      }
    }
  }
}

// ── SERVE ─────────────────────────────────────────────────────────────────────
serve(async (req) => {
  if(req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  try {
    const body = await req.json();
    const { type, ...payload } = body;

    if(type === "scheduled_punch_check") {
      await checkDuePunchItems();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const handler = handlers[type];
    if(!handler) {
      return new Response(JSON.stringify({ error: `Unknown notification type: ${type}` }), { status: 400 });
    }

    await handler(payload);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });

  } catch(e) {
    console.error("Edge function error:", e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
