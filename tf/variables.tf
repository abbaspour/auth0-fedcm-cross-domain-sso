## Provider credentials (terraform.auto.tfvars) ###############################

variable "auth0_domain" {
  description = "Canonical tenant domain used for the Management API"
  type        = string
  default     = "fedcm-demo.au.auth0.com"
}

variable "auth0_tf_client_id" {
  description = "M2M client authorised for the Management API"
  type        = string
}

variable "auth0_tf_client_secret" {
  type      = string
  sensitive = true
}

variable "cloudflare_email" {
  type = string
}

variable "cloudflare_api_key" {
  description = "Cloudflare global API key (used together with cloudflare_email)"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Account that owns the IdP zone"
  type        = string
}

## Demo topology ##############################################################

variable "idp_zone" {
  description = "Cloudflare zone (eTLD+1) of the IdP. Serves /.well-known/web-identity at its apex."
  type        = string
  default     = "abbaspour.net"
}

variable "idp_domain" {
  description = "Auth0 self-managed custom domain, fronted by the fedcm-idp Worker"
  type        = string
  default     = "fedcm-id.abbaspour.net"
}

variable "login_app_host" {
  description = "Same-site SPA used to establish the Auth0 session with a classic redirect login"
  type        = string
  default     = "fedcm-app.abbaspour.net"
}

variable "rp_app_host" {
  description = "Cross-site SPA that signs in with FedCM"
  type        = string
  default     = "fedcm-app.slipbox.uk"
}

variable "create_apex_record" {
  description = "Create a proxied placeholder record for the zone apex so the well-known Worker route receives traffic. Leave false if the apex already has a proxied record."
  type        = bool
  default     = false
}

variable "demo_user_email" {
  type = string
}

variable "demo_user_name" {
  type    = string
  default = "FedCM Demo User"
}

variable "demo_user_password" {
  type      = string
  sensitive = true
}
