// Fonction serveur Vercel — publique : vérifier / accepter une invitation.
// { action: 'check', token } -> { serverName, email, role }
// { action: 'accept', token, username, displayName, password, color } -> { ok, email }
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ROLE_DEFAULT_PERMS = {
  moderator: { createTasks: true,  editAnyTask: true,  editOwnTask: true,  deleteAnyTask: true,  deleteOwnTask: true,  sendMessages: true },
  member:    { createTasks: true,  editAnyTask: false, editOwnTask: true,  deleteAnyTask: false, deleteOwnTask: true,  sendMessages: true },
  guest:     { createTasks: false, editAnyTask: false, editOwnTask: false, deleteAnyTask: false, deleteOwnTask: false, sendMessages: true },
};

async function loadInvite(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return { error: "Lien d'invitation invalide." };
  const { data: invite } = await supabaseAdmin.from('invites').select('*').eq('token', token).single();
  if (!invite) return { error: "Lien d'invitation invalide." };
  if (invite.used_at) return { error: 'Cette invitation a déjà été utilisée.' };
  if (new Date(invite.expires_at) < new Date()) return { error: "Cette invitation a expiré. Demande à l'administrateur de t'en renvoyer une." };
  const { data: server } = await supabaseAdmin.from('servers').select('name').eq('id', invite.server_id).single();
  return { invite, serverName: server?.name || 'Le Carnet' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { action, token } = req.body || {};
    const loaded = await loadInvite(token);
    if (loaded.error) return res.status(400).json({ error: loaded.error });
    const { invite, serverName } = loaded;

    if (action === 'check') {
      return res.status(200).json({ ok: true, serverName, email: invite.email, role: invite.role });
    }
    if (action !== 'accept') return res.status(400).json({ error: 'Action inconnue.' });

    const username = String(req.body.username || '').trim();
    const displayName = String(req.body.displayName || '').trim();
    const password = String(req.body.password || '');
    const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color || '') ? req.body.color : '#5B9EF5';
    if (!username || !displayName) return res.status(400).json({ error: 'Identifiant et nom affiché requis.' });
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -)." });
    if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });

    const { data: taken } = await supabaseAdmin.from('profiles').select('id').ilike('username', username).limit(1);
    if (taken && taken.length) return res.status(400).json({ error: 'Cet identifiant est déjà pris, choisis-en un autre.' });

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: invite.email, password, email_confirm: true,
    });
    if (createErr) {
      const msg = /already|registered|exists/i.test(createErr.message)
        ? 'Cette adresse a déjà un compte. Connecte-toi plutôt.' : createErr.message;
      return res.status(400).json({ error: msg });
    }

    const { error: profileErr } = await supabaseAdmin.from('profiles').insert({
      id: created.user.id,
      server_id: invite.server_id,
      username, email: invite.email, display_name: displayName, color,
      role: invite.role,
      permissions: ROLE_DEFAULT_PERMS[invite.role] || ROLE_DEFAULT_PERMS.member,
      status: 'approved',
    });
    if (profileErr) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
      const msg = /duplicate|unique/i.test(profileErr.message) ? 'Cet identifiant est déjà pris, choisis-en un autre.' : profileErr.message;
      return res.status(400).json({ error: msg });
    }

    await supabaseAdmin.from('invites').update({ used_at: new Date().toISOString() }).eq('id', invite.id);
    return res.status(200).json({ ok: true, email: invite.email });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
