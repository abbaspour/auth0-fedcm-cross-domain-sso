locals {
  idp_origin       = "https://${var.idp_domain}"
  login_app_origin = "https://${var.login_app_host}"
  rp_app_origin    = "https://${var.rp_app_host}"
}

data "cloudflare_zone" "idp" {
  filter = {
    name    = var.idp_zone
    account = { id = var.cloudflare_account_id }
  }
}

## Custom domain ##############################################################

resource "auth0_custom_domain" "idp" {
  domain                  = var.idp_domain
  type                    = "self_managed_certs"
  custom_client_ip_header = "true-client-ip"
}

resource "cloudflare_dns_record" "idp_verification" {
  zone_id = data.cloudflare_zone.idp.id
  name    = auth0_custom_domain.idp.verification[0].methods[0].domain
  type    = "TXT"
  content = "\"${auth0_custom_domain.idp.verification[0].methods[0].record}\""
  ttl     = 300
  comment = "Auth0 custom domain verification for ${var.idp_domain}"
}

resource "auth0_custom_domain_verification" "idp" {
  custom_domain_id = auth0_custom_domain.idp.id

  timeouts {
    create = "15m"
  }

  depends_on = [cloudflare_dns_record.idp_verification]
}

# Placeholder target: the fedcm-idp Worker route handles every request on this host
# and proxies Auth0 traffic to origin_domain_name itself.
resource "cloudflare_dns_record" "idp" {
  zone_id = data.cloudflare_zone.idp.id
  name    = var.idp_domain
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Served by the fedcm-idp Worker"

  depends_on = [auth0_custom_domain_verification.idp]
}

resource "cloudflare_dns_record" "apex" {
  count = var.create_apex_record ? 1 : 0

  zone_id = data.cloudflare_zone.idp.id
  name    = var.idp_zone
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Lets the fedcm-idp Worker serve /.well-known/web-identity"
}

## Applications ###############################################################

resource "auth0_client" "login_app" {
  name            = "FedCM Demo - Login app (${var.login_app_host})"
  description     = "Same-site SPA; classic redirect login that establishes the Auth0 session"
  app_type        = "spa"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code"]

  callbacks           = [local.login_app_origin, "${local.login_app_origin}/"]
  allowed_logout_urls = [local.login_app_origin, "${local.login_app_origin}/"]
  web_origins         = [local.login_app_origin]
  allowed_origins     = [local.login_app_origin]

  jwt_configuration {
    alg = "RS256"
  }
}

resource "auth0_client_credentials" "login_app" {
  client_id             = auth0_client.login_app.id
  authentication_method = "none"
}

resource "auth0_client" "rp_app" {
  name            = "FedCM Demo - RP app (${var.rp_app_host})"
  description     = "Cross-site SPA; receives an authorization code through FedCM"
  app_type        = "spa"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code"]

  callbacks           = [local.rp_app_origin, "${local.rp_app_origin}/"]
  allowed_logout_urls = [local.rp_app_origin, "${local.rp_app_origin}/"]
  web_origins         = [local.rp_app_origin]
  allowed_origins     = [local.rp_app_origin]

  jwt_configuration {
    alg = "RS256"
  }
}

resource "auth0_client_credentials" "rp_app" {
  client_id             = auth0_client.rp_app.id
  authentication_method = "none"
}

# Used only server-side by the Worker: resolves "who is logged in?" for the FedCM
# accounts endpoint (prompt=none) and runs the FedCM login_url pop-up.
resource "auth0_client" "bridge" {
  name            = "FedCM Demo - IdP bridge (Worker)"
  description     = "Confidential client owned by the fedcm-idp Worker. Never issues tokens to browsers."
  app_type        = "regular_web"
  is_first_party  = true
  oidc_conformant = true
  grant_types     = ["authorization_code"]

  callbacks = ["${local.idp_origin}/fedcm/callback"]

  jwt_configuration {
    alg = "RS256"
  }
}

resource "auth0_client_credentials" "bridge" {
  client_id             = auth0_client.bridge.id
  authentication_method = "client_secret_post"
}

## Users ######################################################################

resource "auth0_connection" "users" {
  name     = "fedcm-demo-users"
  strategy = "auth0"

  options {
    password_policy        = "good"
    brute_force_protection = true
    disable_signup         = false
  }
}

resource "auth0_connection_clients" "users" {
  connection_id = auth0_connection.users.id
  enabled_clients = [
    auth0_client.login_app.id,
    auth0_client.rp_app.id,
    auth0_client.bridge.id,
    var.auth0_tf_client_id
  ]
}

resource "auth0_user" "demo" {
  connection_name = auth0_connection.users.name
  email           = var.demo_user_email
  email_verified  = true
  name            = var.demo_user_name
  password        = var.demo_user_password
}
