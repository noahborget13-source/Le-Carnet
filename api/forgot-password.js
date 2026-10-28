// Fonction serveur Vercel — publique : envoie un lien pour choisir un nouveau mot de passe.
// On répond toujours « ok » pour ne pas révéler quelles adresses ont un compte.
import { createClient } from '@supabase/supabase-js';
import { esc, siteUrl, layout, button, sendMail, mailConfigured } from './_mail.js';

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const lastSent = new Map(); // anti-spam simple : une demande par adresse et par minute

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  try {
    const identifier = String((req.body || {}).identifier || '').trim();
    if (!identifier || identifier.length > 120) return res.status(400).json({ error: 'Renseignez votre email ou votre identifiant.' });
    if (!mailConfigured()) return res.status(500).json({ error: "L'envoi d'emails n'est pas encore configuré sur ce site." });

    const column = identifier.includes('@') ? 'email' : 'username';
    const { data: profiles } = await supabaseAdmin.from('profiles').select('email, display_name').ilike(column, identifier).limit(1);
    const profile = profiles && profiles[0];
    if (profile) {
      const key = profile.email.toLowerCase();
      if (!lastSent.has(key) || Date.now() - lastSent.get(key) > 60000) {
        lastSent.set(key, Date.now());
        const { data, error } = await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery', email: profile.email, options: { redirectTo: `${siteUrl(req)}/app/` },
        });
        const link = data?.properties?.action_link;
        if (!error && link) {
          await sendMail({
            to: profile.email,
            subject: 'Nouveau mot de passe — Le Carnet',
            text: `Bonjour ${profile.display_name}, voici le lien pour choisir un nouveau mot de passe (valable peu de temps) : ${link}\nSi vous n'avez rien demandé, ignorez ce message.`,
            html: layout(`<p>Bonjour ${esc(profile.display_name)},</p><p>Vous avez demandé à changer votre mot de passe.</p>${button(link, 'Choisir un nouveau mot de passe')}<p style="font-size:13px;color:#667">Ce lien est valable peu de temps. Si vous n'avez rien demandé, ignorez simplement ce message.</p>`),
          });
        }
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur' });
  }
}
