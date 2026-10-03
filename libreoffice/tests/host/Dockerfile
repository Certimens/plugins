# The throwaway environment of `make test-host`: a real LibreOffice, its Python bridge (UNO)
# and nothing else. Installing LibreOffice on a developer's machine for a test suite would be
# out of proportion — here the image is thrown away with one command (`make test-host-clean`).
#
# The agent is mounted read-only at launch: nothing from this repository enters the image, and
# the LibreOffice profile the suite creates lives in /tmp, inside the container.
FROM debian:bookworm-slim

# libreoffice-writer for the word processor, python3-uno for the bridge the suite uses — the
# same one the extension uses once installed.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-core python3-uno python3 \
        fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# `unopkg` refuses to run as root without --shared: that is the right objection, and the path
# we want to put to the test is the student's anyway, who installs the extension for
# themselves.
RUN useradd --create-home --uid 1000 certimens
USER certimens
ENV HOME=/home/certimens

WORKDIR /agent
CMD ["python3", "-I", "/agent/tests/host/run.py"]
