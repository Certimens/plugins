"""What the agent says when something goes wrong, in one place.

LibreOffice gives an extension no console of its own: whatever is written goes to the terminal
LibreOffice was started from, or nowhere at all. So this stays deliberately small — the standard
library's logging, one named logger, and a `warn()` that never raises on its way out. An agent
that crashed while reporting a failure would take the measurement down with it.

Nothing here ever carries what the student wrote: a message names an operation and its error,
the way the rest of the agent does.
"""

import logging

logger = logging.getLogger('certimens')


def warn(message, err=None):
    """Reports a failure the agent recovered from. Never raises."""
    try:
        logger.warning('Certimens: %s%s', message, '' if err is None else ': %s' % err)
    except Exception:
        pass
