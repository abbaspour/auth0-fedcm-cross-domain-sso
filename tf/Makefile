SHELL := bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := plan

PLAN := tfplan

.PHONY: init plan apply output clean

.terraform:
	terraform init

init:
	terraform init -upgrade

plan: .terraform
	terraform plan -out=$(PLAN)

# Applies the saved plan from `make plan`; run that first so you've reviewed what changes
apply: .terraform
	@[[ -f $(PLAN) ]] || { echo >&2 "ERROR: no $(PLAN); run 'make plan' first"; exit 1; }
	terraform apply $(PLAN)
	rm -f $(PLAN)

output:
	terraform output

clean:
	rm -f $(PLAN)
