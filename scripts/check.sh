#!/usr/bin/env bash

set -ueo pipefail

DIR="${BASH_SOURCE[0]%/*}"
[ "$DIR" = "${BASH_SOURCE[0]}" ] && DIR="."
readonly DIR

command -v curl >/dev/null || { echo >&2 "error: curl not found"; exit 3; }
command -v jq >/dev/null   || { echo >&2 "error: jq not found";   exit 3; }

function usage() {
    cat <<END >&2
USAGE: $0 [-d idp_domain] [-w well_known_domain] [-a app_host]... [-h]
        -d domain      # IdP / Auth0 custom domain (default fedcm-id.abbaspour.net)
        -w domain      # eTLD+1 serving /.well-known/web-identity (default abbaspour.net)
        -a host        # SPA host to check; repeatable (default both demo apps)
        -h|?           # usage

Live smoke checks after deploy. Fails if the well-known file and config.json disagree.

eg,
     $0 -d fedcm-id.abbaspour.net -w abbaspour.net
END
    exit $1
}

declare IDP_DOMAIN='fedcm-id.abbaspour.net'
declare WELL_KNOWN_DOMAIN='abbaspour.net'
declare -a app_hosts=()
declare -i failures=0

while getopts ":d:w:a:h?" opt; do
    case ${opt} in
    d) IDP_DOMAIN=${OPTARG} ;;
    w) WELL_KNOWN_DOMAIN=${OPTARG} ;;
    a) app_hosts+=("${OPTARG}") ;;
    h | ?) usage 0 ;;
    \?) [[ "${OPTARG}" == "?" ]] && usage 0
        echo >&2 "ERROR: illegal option -- ${OPTARG}"
        usage 1 ;;
    :) echo >&2 "ERROR: option requires an argument -- ${OPTARG}"; usage 1 ;;
    esac
done

[[ ${#app_hosts[@]} -gt 0 ]] || app_hosts=('fedcm-app.abbaspour.net' 'fedcm-app.slipbox.uk')

readonly IDP_ORIGIN="https://${IDP_DOMAIN}"

function check() {
    local name="$1"; shift
    if "$@"; then
        echo >&2 "ok    ${name}"
    else
        echo >&2 "FAIL  ${name}"
        failures+=1
    fi
}

function json_get() {
    curl -sf --max-time 10 -H 'accept: application/json' --url "$1"
}

well_known=$(json_get "https://${WELL_KNOWN_DOMAIN}/.well-known/web-identity" || echo '{}')
readonly well_known
config=$(json_get "${IDP_ORIGIN}/fedcm/config.json" || echo '{}')
readonly config
discovery=$(json_get "${IDP_ORIGIN}/.well-known/openid-configuration" || echo '{}')
readonly discovery

function well_known_lists_config() {
    jq -e --arg u "${IDP_ORIGIN}/fedcm/config.json" '.provider_urls | index($u) != null' <<< "${well_known}" >/dev/null
}

function same_field() {
    local field="$1"
    local a b
    a=$(jq -r --arg f "${field}" '.[$f] // empty' <<< "${well_known}")
    b=$(jq -r --arg f "${field}" '.[$f] // empty' <<< "${config}")
    [[ -n "${a}" && "${a}" == "${b}" ]] || { echo >&2 "      well-known: '${a}'  config.json: '${b}'"; return 1; }
}

function issuer_is_custom_domain() {
    [[ $(jq -r '.issuer // empty' <<< "${discovery}") == "${IDP_ORIGIN}/" ]]
}

function accounts_rejects_anonymous() {
    [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Sec-Fetch-Dest: webidentity' \
        --url "${IDP_ORIGIN}/fedcm/accounts") == 401 ]]
}

function app_serves() {
    [[ $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --url "https://$1/") == 200 ]]
}

check "well-known lists ${IDP_ORIGIN}/fedcm/config.json" well_known_lists_config
check "accounts_endpoint matches between well-known and config.json" same_field accounts_endpoint
check "login_url matches between well-known and config.json" same_field login_url
check "Auth0 issuer is ${IDP_ORIGIN}/ (proxy works)" issuer_is_custom_domain
check "/fedcm/accounts returns 401 without a session" accounts_rejects_anonymous
for host in "${app_hosts[@]}"; do
    check "app https://${host}/ serves" app_serves "${host}"
done

[[ ${failures} -eq 0 ]] || { echo >&2 "${failures} check(s) failed"; exit 1; }
echo >&2 "all checks passed"
