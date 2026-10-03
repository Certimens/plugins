// The addresses an engine may be reached at, and the ones it may not.
//
// Four agents implement this rule, in two languages, from one pattern that `make check`
// compares character for character. That catches a pattern edited in one agent and not the
// three others — it says nothing about whether the pattern is *right*, which is what this
// table is for. The three JavaScript agents read it from here through the symbolic link on
// `tests/helpers`; `libreoffice/tests/test_engine.py` repeats the same cases, deliberately, and
// a divergence between the implementations shows up in one of the four first.
//
// What the rule protects is an API token that never expires: over plain `http:` to a host
// outside the building it crosses the network in the clear, and a token read once is a token
// kept (SECURITY.md, second promise).

export const ALLOWED = [
    // https goes anywhere: that is the whole point of asking for it.
    'https://monespace.certimens.fr',
    'https://moodle.univ-exemple.fr:8443/certimens',
    // An establishment serving its engine on its own intranet, which is the deployment plain
    // http exists for: a name only an internal resolver answers, and the private ranges.
    'http://moteur',
    'http://certimens-srv:9000',
    'http://ecole.local',
    'http://10.0.0.1',
    'http://172.16.3.9',
    'http://172.31.255.254',
    'http://192.168.1.5',
    'http://[fd00::1]',
    // A developer against their own machine.
    'http://localhost:8080',
    'http://sub.localhost',
    'http://127.0.0.1:3000',
    'http://127.1.2.3',
    'http://[::1]:80',
];

export const REFUSED = [
    // Plain http to a public host: this is the case the rule exists for.
    'http://moodle.univ-exemple.fr',
    'http://monespace.certimens.fr',
    'http://8.8.8.8',
    'http://[2001:db8::1]',
    // 172.16/12 stops at 172.31, and 172.15 is somebody else's.
    'http://172.15.0.1',
    'http://172.32.0.1',
    // A public address written to look like a hostname: 134744072 is 8.8.8.8. The two sides
    // refuse it for different reasons, and both are right — `new URL` normalises the integer
    // back to `8.8.8.8` and the rule reads a public address, while Python's `urlparse` hands
    // over `134744072` as it stands and the all-digit guard is what catches it.
    //
    // Which is why the *loopback* written that way (2130706433 is 127.0.0.1) is in neither
    // list: the JavaScript agents accept it, having resolved it, and the LibreOffice one
    // refuses it, not having. Nobody writes an address that way, both answers are safe, and a
    // case the four cannot agree on does not belong in a table about what they share.
    'http://134744072/',
    // Not addresses a browser should follow at all. `javascript:` matters most: the address
    // ends up in an `href`, in windows that hold the token.
    'javascript:alert(1)',
    'file:///etc/passwd',
    'ftp://files.univ-exemple.fr',
    'data:text/html,<script>1</script>',
    // Not a URL, or not one with a host.
    'monespace.certimens.fr',
    'https://',
    '',
    '   ',
];
