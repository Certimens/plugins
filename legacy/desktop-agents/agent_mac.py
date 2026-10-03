import time
import os
import sys
import json
import uuid
import threading
import urllib.request
import subprocess
import statistics
import zipfile
import io
from pynput import keyboard, mouse
import pystray
from pystray import MenuItem as item
from PIL import Image, ImageDraw
import tkinter as tk
from tkinter import messagebox
from ApplicationServices import AXIsProcessTrustedWithOptions, kAXTrustedCheckOptionPrompt
from http.server import BaseHTTPRequestHandler, HTTPServer

# --- ÉTAT GLOBAL ET CONFIG ---
AGENT_VERSION = "5.13 - Injection ZIP Native (Mac)"
is_paused = False
agent_running = True

app_data_dir = os.path.expanduser("~/Library/Application Support/Certimens")
if not os.path.exists(app_data_dir):
    os.makedirs(app_data_dir)

CONFIG_FILE = os.path.join(app_data_dir, "certimens_config.json")
CACHE_FILE = os.path.join(app_data_dir, "certimens_cache.json")

student_email = ""
global_icon = None

etat_fenetre = "NODOC"
chemin_document_actuel = ""
id_document_actuel = ""
avertissement_non_sauvegarde_affiche = False
was_word_focused = False
last_mtime = 0

session_actuelle_id = ""
nom_fenetre_actuelle = ""
session_web_id = None 

data_lock = threading.RLock()
serveur_local = None 

# --- VARIABLES MOTEUR IFC ---
touches_enfoncees = set()
injections_detectees = []
flight_times = []
last_press_time = 0
timestamp_debut = None

last_event_time = 0
last_activity_time = 0
packet_active_time_ms = 0
packet_keystrokes = 0

corrections_immediates = 0
reformulations_differees = 0
sauts_navigation = 0
is_navigating = False
macro_repentirs = 0
pauses_cognitives = 0
mouse_clicked_recently = False

def calculate_mad(data):
    if len(data) < 2: return 0.0
    med = statistics.median(data)
    deviations = [abs(x - med) for x in data]
    return statistics.median(deviations)

def get_mac_clipboard():
    try: return subprocess.check_output(['pbpaste']).decode('utf-8')
    except: return ""

def envoyer_notification(titre, message):
    try:
        msg_safe = message.replace('"', '\\"')
        titre_safe = titre.replace('"', '\\"')
        script = f'display notification "{msg_safe}" with title "{titre_safe}"'
        subprocess.Popen(['osascript', '-e', script], stderr=subprocess.DEVNULL)
    except Exception:
        pass

def afficher_alerte_sauvegarde():
    script_alerte = """
    tell application "System Events"
        activate
        display alert "⚠️ Action Requise" message "Enregistrez votre document (Cmd+S) pour démarrer la certification Certimens." as warning buttons {"J'ai compris"} default button "J'ai compris"
    end tell
    """
    subprocess.Popen(['osascript', '-e', script_alerte], stderr=subprocess.DEVNULL)

def vider_memoire_tampon():
    global packet_active_time_ms, packet_keystrokes, last_activity_time
    global corrections_immediates, reformulations_differees, sauts_navigation, flight_times
    global macro_repentirs, pauses_cognitives
    global injections_detectees, timestamp_debut

    with data_lock:
        if packet_keystrokes > 0 or len(injections_detectees) > 0:
            current_utc = int(time.time())
            nouveau_paquet = {
                "student_email": student_email,
                "hardware_id": str(uuid.getnode()),
                "session_id": session_actuelle_id,
                "active_window": nom_fenetre_actuelle,
                "timestamp_debut": timestamp_debut,
                "timestamp_fin": current_utc,
                "temps_actif_ms": int(packet_active_time_ms),
                "temps_effectif_secondes": int(packet_active_time_ms / 1000), 
                "injections_detectees": list(injections_detectees),
                "metrics": {
                    "total_frappes_brutes": packet_keystrokes,
                    "corrections_immediates": corrections_immediates,
                    "reformulations_differees": reformulations_differees,
                    "sauts_navigation": sauts_navigation,
                    "macro_repentirs": macro_repentirs,
                    "pauses_cognitives": pauses_cognitives,
                    "mad_moyen_ms": round(calculate_mad(flight_times), 2)
                }
            }
            threading.Thread(target=envoyer_donnees, args=(nouveau_paquet,), daemon=True).start()
            
            injections_detectees, flight_times = [], []
            timestamp_debut = None
            packet_active_time_ms, packet_keystrokes, last_activity_time = 0, 0, 0
            corrections_immediates, reformulations_differees, sauts_navigation = 0, 0, 0
            macro_repentirs, pauses_cognitives = 0, 0

# --- NOUVEAU : INJECTION ZIP NATIVE (SANS WORD) ---
def injecter_uuid_google_doc_native(filepath, doc_id_navigateur):
    filepath = os.path.normpath(filepath)
    id_final = f"GDOCS-{doc_id_navigateur}" if not str(doc_id_navigateur).startswith("GDOCS-") else str(doc_id_navigateur)
    
    # 1. Attente que Firefox ait fini de télécharger le fichier
    for _ in range(20):
        if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
            try:
                with open(filepath, 'a'): pass # Vérifie que le fichier n'est plus verrouillé
                break
            except: pass
        time.sleep(0.5)
        
    # 2. Manipulation chirurgicale de l'archive ZIP (.docx) en mémoire
    try:
        with open(filepath, 'rb') as f:
            zip_data = f.read()
            
        zin = zipfile.ZipFile(io.BytesIO(zip_data), 'r')
        zout_buf = io.BytesIO()
        zout = zipfile.ZipFile(zout_buf, 'w')
        
        has_custom = False
        for item in zin.infolist():
            content = zin.read(item.filename)
            if item.filename == 'docProps/custom.xml':
                has_custom = True
                if b'Certimens_ID' not in content:
                    if b'</Properties>' in content:
                        prop_xml = f'<property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="999" name="Certimens_ID"><vt:lpwstr>{id_final}</vt:lpwstr></property></Properties>'.encode('utf-8')
                        content = content.replace(b'</Properties>', prop_xml)
                    elif b'</op:Properties>' in content:
                        prop_xml = f'<op:property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="999" name="Certimens_ID"><vt:lpwstr>{id_final}</vt:lpwstr></op:property></op:Properties>'.encode('utf-8')
                        content = content.replace(b'</op:Properties>', prop_xml)
            elif item.filename == '_rels/.rels':
                if b'custom-properties' not in content:
                    content = content.replace(b'</Relationships>', b'<Relationship Id="rIdCertimens" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/></Relationships>')
            zout.writestr(item, content)
        
        # 3. Si le fichier vient de Google Docs, on crée la propriété de toute pièce
        if not has_custom:
            custom_xml = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{{D5CDD505-2E9C-101B-9397-08002B2CF9AE}}" pid="2" name="Certimens_ID"><vt:lpwstr>{id_final}</vt:lpwstr></property></Properties>'
            zout.writestr('docProps/custom.xml', custom_xml.encode('utf-8'))
            
        zin.close()
        zout.close()
        
        # 4. Sauvegarde instantanée
        with open(filepath, 'wb') as f:
            f.write(zout_buf.getvalue())
            
    except Exception as e:
        print(f"Erreur d'injection ZIP : {e}")

class ReusableHTTPServer(HTTPServer):
    allow_reuse_address = True 

class PluginHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200, "ok")
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header("Access-Control-Allow-Headers", "X-Requested-With, Content-type")
        self.end_headers()

    def do_POST(self):
        global session_web_id
        try:
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            data = json.loads(post_data.decode('utf-8'))
            
            if data.get("action") == "UPDATE_DOC_ID": 
                if session_web_id != data.get("documentId"):
                    vider_memoire_tampon() 
                session_web_id = data.get("documentId")
            elif data.get("action") == "CLEAR_DOC_ID": 
                if session_web_id is not None:
                    vider_memoire_tampon() 
                session_web_id = None
            elif data.get("action") == "TAG_DOWNLOAD":
                vider_memoire_tampon()
                doc_id = data.get("documentId")
                filepath = data.get("filepath")
                # ON UTILISE LA NOUVELLE FONCTION NATIVE
                threading.Thread(target=injecter_uuid_google_doc_native, args=(filepath, doc_id), daemon=True).start()
                
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
        except Exception: pass
    def log_message(self, format, *args): return

def ecouter_navigateur():
    global serveur_local
    try:
        serveur_local = ReusableHTTPServer(('127.0.0.1', 14567), PluginHandler)
        serveur_local.timeout = 1
        while agent_running:
            serveur_local.handle_request()
    except Exception:
        pass

# --- ONBOARDING & PERMISSIONS ---
def charger_config():
    global student_email
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, 'r') as f:
            config = json.load(f)
            student_email = config.get("email", "")
            return True
    return False

def afficher_onboarding():
    global student_email
    root = tk.Tk()
    root.title("Certimens - Configuration Initiale")
    root.geometry("400x250")
    root.eval('tk::PlaceWindow . center')
    tk.Label(root, text="Bienvenue sur Certimens (Mac)", font=("Arial", 14, "bold")).pack(pady=10)
    tk.Label(root, text="Veuillez saisir votre e-mail institutionnel :").pack()
    email_entry = tk.Entry(root, width=40)
    email_entry.pack(pady=5)
    
    def valider():
        email = email_entry.get().strip()
        if not email or "@" not in email:
            messagebox.showerror("Erreur", "E-mail invalide.")
            return
        with open(CONFIG_FILE, 'w') as f:
            json.dump({"email": email}, f)
        global student_email
        student_email = email
        root.destroy()

    tk.Button(root, text="Valider & Démarrer", command=valider).pack(pady=10)
    os.system('''/usr/bin/osascript -e 'tell app "Finder" to set frontmost of process "Python" to true' ''')
    root.mainloop()

def verifier_permissions_mac():
    options = {kAXTrustedCheckOptionPrompt: True}
    if not AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: False}):
        root = tk.Tk()
        root.withdraw()
        messagebox.showwarning("Autorisation", "Veuillez autoriser l'Accessibilité pour le Terminal/Python.")
        AXIsProcessTrustedWithOptions(options)
        while not AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: False}):
            time.sleep(2)
        root.destroy()

# --- THREAD DE SURVEILLANCE WORD (BUREAU) ---
def gerer_tatouage_et_sauvegarde(nouvel_uuid):
    script = f"""
    tell application "System Events"
        if not (exists process "Microsoft Word") then return "ERREUR|||NOT_RUNNING"
    end tell
    tell application "Microsoft Word"
        set doc to active document
        try
            set cat to value of document property "category" of doc
            if cat starts with "CERTIMENS|||" then
                set current_id to text 13 thru -1 of cat
                return "EXISTANT|||" & current_id
            else
                set value of document property "category" of doc to "CERTIMENS|||{nouvel_uuid}"
                save doc 
                return "NOUVEAU|||{nouvel_uuid}"
            end if
        on error
            try
                set value of document property "category" of doc to "CERTIMENS|||{nouvel_uuid}"
                save doc
                return "NOUVEAU|||{nouvel_uuid}"
            on error
                return "ERREUR|||ECHEC_INJECTION"
            end try
        end try
    end tell
    """
    try:
        res = subprocess.check_output(['osascript', '-e', script], stderr=subprocess.DEVNULL).decode('utf-8').strip()
        if "|||" in res:
            return res.split("|||", 1)
        return "ERREUR", None
    except Exception:
        return "ERREUR", None

def thread_surveillance_word():
    global etat_fenetre, chemin_document_actuel, id_document_actuel
    global was_word_focused, last_mtime
    script_etat = """
    tell application "System Events"
        if not (exists process "Microsoft Word") then return "CLOSED|||"
        set frontApp to name of first application process whose frontmost is true
    end tell
    if frontApp is "Microsoft Word" then
        tell application "Microsoft Word"
            if (count of documents) > 0 then
                set doc to active document
                try
                    set p to path of doc
                    if p is "" or p is missing value then error
                    set cheminComplet to POSIX path of (full name of doc as alias)
                    return "SAVED|||" & cheminComplet
                on error
                    return "UNSAVED|||" & name of doc
                end try
            end if
        end tell
        return "NODOC|||"
    end if
    return "LOSTFOCUS|||"
    """
    while agent_running:
        time.sleep(1.0)
        if is_paused: continue
        try:
            res = subprocess.check_output(['osascript', '-e', script_etat], stderr=subprocess.DEVNULL).decode('utf-8').strip()
            if "|||" in res:
                statut, valeur = res.split("|||", 1)
                
                if statut == "SAVED":
                    was_word_focused = True
                    nouveau_chemin = valeur
                    nom_fichier = os.path.basename(nouveau_chemin)
                    
                    if "Normal.dotm" in nom_fichier or nom_fichier.startswith("~$"):
                        etat_fenetre = "NODOC"
                        continue
                        
                    etat_fenetre = statut
                    if nouveau_chemin != chemin_document_actuel:
                        nouvel_id = str(uuid.uuid4())
                        statut_id, doc_id = gerer_tatouage_et_sauvegarde(nouvel_id)
                        if statut_id in ["EXISTANT", "NOUVEAU"]:
                            chemin_document_actuel = nouveau_chemin
                            id_document_actuel = doc_id
                            if statut_id == "NOUVEAU":
                                envoyer_notification("Certimens ✅", "Document Word sécurisé.")
                    
                    try:
                        mtime = os.path.getmtime(chemin_document_actuel)
                        if last_mtime > 0 and mtime > last_mtime:
                            vider_memoire_tampon() 
                        last_mtime = mtime
                    except: pass
                    
                elif statut in ["LOSTFOCUS", "CLOSED", "NODOC"]:
                    if was_word_focused:
                        vider_memoire_tampon()
                        was_word_focused = False
                    etat_fenetre = "NODOC"
                
                elif statut == "UNSAVED":
                    was_word_focused = True
                    etat_fenetre = "UNSAVED"
            else:
                etat_fenetre = "NODOC"
        except Exception:
            etat_fenetre = "NODOC"

# --- CAPTATION BIOMÉTRIQUE ---
def on_click(x, y, button, pressed):
    global sauts_navigation, is_navigating, mouse_clicked_recently, last_event_time
    current_time = time.time()
    
    is_web = (session_web_id is not None)
    if pressed and agent_running and not is_paused and (etat_fenetre == "SAVED" or is_web):
        with data_lock:
            sauts_navigation += 1
            is_navigating = True
            mouse_clicked_recently = True 
            
            if last_event_time > 0:
                delay = current_time - last_event_time
                if 3.0 < delay <= 60.0:
                    global pauses_cognitives
                    pauses_cognitives += 1
            last_event_time = current_time

def on_press(key):
    global last_press_time, timestamp_debut, avertissement_non_sauvegarde_affiche
    global packet_active_time_ms, packet_keystrokes, last_activity_time, last_event_time
    global injections_detectees, flight_times
    global corrections_immediates, reformulations_differees, sauts_navigation, is_navigating
    global mouse_clicked_recently, macro_repentirs, pauses_cognitives
    global session_actuelle_id, nom_fenetre_actuelle

    if is_paused or not agent_running: return
    
    is_web = (session_web_id is not None)

    if not is_web and etat_fenetre == "UNSAVED":
        if not avertissement_non_sauvegarde_affiche:
            afficher_alerte_sauvegarde()
            avertissement_non_sauvegarde_affiche = True
        return
        
    elif is_web or etat_fenetre == "SAVED":
        avertissement_non_sauvegarde_affiche = False
        try: k_id = key.char
        except AttributeError: k_id = str(key)
        
        current_time = time.time()
        current_utc = int(current_time)
        
        with data_lock:
            if is_web:
                session_actuelle_id = f"GDOCS-{session_web_id}" if not str(session_web_id).startswith("GDOCS-") else session_web_id
                nom_fenetre_actuelle = "Google Docs / Web"
            else:
                session_actuelle_id = id_document_actuel
                nom_fenetre_actuelle = os.path.basename(chemin_document_actuel) if chemin_document_actuel else "Document Inconnu"

            if k_id in touches_enfoncees: return
            touches_enfoncees.add(k_id)

            if last_event_time > 0:
                delay_since_event = current_time - last_event_time
                if 3.0 < delay_since_event <= 60.0:
                    pauses_cognitives += 1
            last_event_time = current_time

            if last_press_time > 0:
                delay_flight = (current_time - last_press_time) * 1000
                if delay_flight < 800:
                    flight_times.append(delay_flight)
                    if len(flight_times) > 100: flight_times.pop(0)
            last_press_time = current_time

            if key == keyboard.Key.backspace or key == keyboard.Key.delete:
                if mouse_clicked_recently:
                    macro_repentirs += 1 
                elif is_navigating: 
                    reformulations_differees += 1 
                else: 
                    corrections_immediates += 1 
            elif key in [keyboard.Key.left, keyboard.Key.right, keyboard.Key.up, keyboard.Key.down]:
                sauts_navigation += 1
                is_navigating = True
            else:
                if type(key) == keyboard.Key and key in [keyboard.Key.shift, keyboard.Key.cmd, keyboard.Key.alt, keyboard.Key.ctrl]: pass
                else: is_navigating = False
                
            mouse_clicked_recently = False 

            is_cmd_pressed = any(k in touches_enfoncees for k in ['Key.cmd_l', 'Key.cmd_r', 'Key.cmd'])
            
            if is_cmd_pressed and k_id in ['x', 'X']:
                macro_repentirs += 1
            
            if is_cmd_pressed and k_id in ['s', 'S']:
                threading.Thread(target=vider_memoire_tampon, daemon=True).start()
                
            if is_cmd_pressed and k_id in ['z', 'Z']: 
                corrections_immediates += 1
                
            if is_cmd_pressed and k_id in ['v', 'V']:
                texte = get_mac_clipboard()
                if texte and len(texte) > 15: injections_detectees.append({"volume_caracteres": len(texte), "timestamp": current_utc})
            
            if timestamp_debut is None: timestamp_debut = current_utc
            if last_activity_time > 0:
                delay_activity = current_time - last_activity_time
                if delay_activity <= 2.0:
                    packet_active_time_ms += (delay_activity * 1000)
                elif delay_activity < 60.0:
                    packet_active_time_ms += 250
            
            last_activity_time = current_time
            packet_keystrokes += 1
            
            if packet_keystrokes >= 200:
                vider_memoire_tampon() 

def on_release(key):
    if is_paused or not agent_running: return
    try: k_id = key.char
    except AttributeError: k_id = str(key)
    with data_lock:
        if k_id in touches_enfoncees: touches_enfoncees.remove(k_id)

def envoyer_donnees(nouveau_paquet):
    cache = []
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r') as f: cache = json.load(f)
        except: pass
        
    if nouveau_paquet: cache.append(nouveau_paquet)
    if not cache: return True

    paquets_restants = []
    succes_total = True

    for p in cache:
        try:
            data = json.dumps(p).encode('utf-8')
            req = urllib.request.Request("http://152.228.140.229:8080/telemetry", data=data)
            req.add_header('Content-Type', 'application/json')
            req.add_header('X-Certimens-Auth', 'CERTIMENS_SECURE_KEY_2026') 
            urllib.request.urlopen(req)
        except Exception:
            paquets_restants.append(p)
            succes_total = False

    if paquets_restants:
        with open(CACHE_FILE, 'w') as f: json.dump(paquets_restants, f)
    elif os.path.exists(CACHE_FILE):
        os.remove(CACHE_FILE)

    set_icon_state("synchro" if succes_total else "attente")
    return succes_total

# --- UI & TRAY MENU ---
def create_image(etat="synchro"):
    couleur_fond = (41, 128, 185) 
    if etat == "pause": couleur_fond = (127, 140, 141) 
    image = Image.new('RGB', (64, 64), color=couleur_fond)
    draw = ImageDraw.Draw(image)
    draw.ellipse((16, 16, 48, 48), fill=(255, 255, 255))
    if etat == "attente": draw.ellipse((44, 44, 64, 64), fill=(231, 76, 60)) 
    elif etat == "synchro" and not is_paused: draw.ellipse((44, 44, 64, 64), fill=(46, 204, 113)) 
    return image

def set_icon_state(etat):
    global global_icon
    if global_icon: global_icon.icon = create_image(etat)

def action_toggle_pause(icon, item):
    global is_paused, avertissement_non_sauvegarde_affiche
    global packet_keystrokes, corrections_immediates, reformulations_differees, sauts_navigation
    global macro_repentirs, pauses_cognitives
    is_paused = not is_paused
    if is_paused:
        with data_lock:
            packet_keystrokes, corrections_immediates, reformulations_differees = 0, 0, 0
            sauts_navigation, macro_repentirs, pauses_cognitives = 0, 0, 0
        envoyer_notification("Certimens ⏸️", "L'analyse est en pause.")
    else:
        avertissement_non_sauvegarde_affiche = False
        envoyer_notification("Certimens ▶️", "L'analyse a repris.")
    set_icon_state("pause" if is_paused else "synchro")

def action_redemarrer(icon, item):
    global session_actuelle_id, nom_fenetre_actuelle, session_web_id
    global chemin_document_actuel, id_document_actuel, etat_fenetre
    global packet_keystrokes, corrections_immediates, reformulations_differees, sauts_navigation
    global macro_repentirs, pauses_cognitives, packet_active_time_ms
    
    envoyer_notification("Certimens 🔄", "Réinitialisation en cours...")
    
    vider_memoire_tampon() 
    
    with data_lock:
        session_actuelle_id = ""
        nom_fenetre_actuelle = ""
        session_web_id = None
        chemin_document_actuel = ""
        id_document_actuel = ""
        etat_fenetre = "NODOC"
        
        packet_keystrokes = 0
        corrections_immediates = 0
        reformulations_differees = 0
        sauts_navigation = 0
        macro_repentirs = 0
        pauses_cognitives = 0
        packet_active_time_ms = 0
        
    envoyer_notification("Certimens ✅", "L'Agent est réinitialisé et prêt.")

def action_quitter(icon, item):
    global agent_running, serveur_local
    agent_running = False
    if serveur_local:
        serveur_local.server_close()
    icon.stop()

def boucle_mise_a_jour_icone():
    while agent_running:
        time.sleep(5)
        if not is_paused:
            if os.path.exists(CACHE_FILE): set_icon_state("attente")
            else: set_icon_state("synchro")

def setup_threads(icon):
    icon.visible = True
    threading.Thread(target=ecouter_navigateur, daemon=True).start()
    threading.Thread(target=thread_surveillance_word, daemon=True).start()
    threading.Thread(target=boucle_mise_a_jour_icone, daemon=True).start()
    
    listener_mouse = mouse.Listener(on_click=on_click)
    listener_mouse.start()
    listener_keyboard = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener_keyboard.start()
    print("✅ Moteur Certimens (Mac V5.13 - Injection ZIP Native) lancé.")
    envoyer_notification("Certimens ✅", "L'Agent est prêt (Bureau & Web).")

if __name__ == "__main__":
    if not charger_config(): 
        afficher_onboarding()
    if not student_email: sys.exit()
    verifier_permissions_mac()

    menu = pystray.Menu(
        item("Paramètres Certimens", lambda: None, enabled=False),
        pystray.MenuItem("---", None),
        item("▶️ Pause / Reprendre l'analyse", action_toggle_pause),
        item("🔄 Actualiser l'Agent", action_redemarrer),
        pystray.MenuItem("---", None),
        item("❌ Quitter l'Agent", action_quitter)
    )
    
    global_icon = pystray.Icon("Certimens", create_image("synchro"), "Certimens", menu)
    global_icon.run(setup_threads)
