#!/usr/bin/env bash

set -ueo pipefail

DIR="${BASH_SOURCE[0]%/*}"
[ "$DIR" = "${BASH_SOURCE[0]}" ] && DIR="."
readonly DIR

function usage() {
    cat <<END >&2
USAGE: $0 [-p plantuml_cmd] [-s source.puml] [-h]
        -p cmd         # PlantUML command (default: plantuml)
        -s file        # diagram source (default ${DIR}/../docs/fedcm-sequence.puml; SVG alongside)
        -h|?           # usage

Fails if the committed SVG was not rendered from the current .puml. PlantUML embeds the
source in every SVG; this compares that embedded copy instead of re-rendering, so the check
does not depend on fonts or PlantUML version.

eg,
     $0 -p "java -jar plantuml.jar"
END
    exit $1
}

declare PLANTUML='plantuml'
declare SOURCE="${DIR}/../docs/fedcm-sequence.puml"

while getopts ":p:s:h?" opt; do
    case ${opt} in
    p) PLANTUML=${OPTARG} ;;
    s) SOURCE=${OPTARG} ;;
    h | ?) usage 0 ;;
    \?) [[ "${OPTARG}" == "?" ]] && usage 0
        echo >&2 "ERROR: illegal option -- ${OPTARG}"
        usage 1 ;;
    :) echo >&2 "ERROR: option requires an argument -- ${OPTARG}"; usage 1 ;;
    esac
done

readonly SVG="${SOURCE%.puml}.svg"
[[ -f "${SOURCE}" ]] || { echo >&2 "ERROR: source missing: ${SOURCE}"; usage 1; }
[[ -f "${SVG}" ]]    || { echo >&2 "ERROR: svg missing: ${SVG}"; usage 1; }

# -metadata output wraps the source in a dashed header naming the file; @startuml loses its name
function normalise() {
    sed -e '/^-\{10,\}$/d' -e '/\.svg$/d' -e 's/^@startuml.*/@startuml/' -e '/^[[:space:]]*$/d'
}

embedded=$(${PLANTUML} -metadata "${SVG}" | normalise)
readonly embedded
current=$(normalise < "${SOURCE}")
readonly current

if [[ "${embedded}" != "${current}" ]]; then
    echo >&2 "ERROR: ${SVG} is stale; run 'make diagram' and commit the result"
    diff <(echo "${embedded}") <(echo "${current}") >&2 || true
    exit 1
fi
echo >&2 "diagram up to date"
