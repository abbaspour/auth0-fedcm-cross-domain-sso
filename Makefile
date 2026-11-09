SHELL := bash
.SHELLFLAGS := -euo pipefail -c

TF := terraform -chdir=tf

.PHONY: all plan infra config deploy-web-identity deploy-idp secrets deploy-apps deploy check test diagram check-diagram tail

all: infra deploy

plan:
	$(MAKE) -C tf plan

infra: plan
	$(MAKE) -C tf apply

config:
	./scripts/gen-config.sh

deploy-web-identity:
	cd workers/web-identity && wrangler deploy

deploy-idp: config
	cd workers/idp && wrangler deploy

secrets:
	$(TF) output -raw cname_api_key | (cd workers/idp && wrangler secret put CNAME_API_KEY)
	$(TF) output -raw bridge_client_secret | (cd workers/idp && wrangler secret put BRIDGE_CLIENT_SECRET)

deploy-apps: config
	cd apps/spa && wrangler deploy --env abbaspour
	cd apps/spa && wrangler deploy --env slipbox

deploy: deploy-web-identity deploy-idp secrets deploy-apps check

test:
	node tests/workers.test.mjs

check:
	./scripts/check.sh

diagram:
	plantuml -tsvg docs/fedcm-sequence.puml

check-diagram:
	./scripts/check-diagram.sh

tail:
	cd workers/idp && wrangler tail --format pretty
