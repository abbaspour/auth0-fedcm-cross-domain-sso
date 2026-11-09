output "idp_domain" {
  value = var.idp_domain
}

output "login_app_host" {
  value = var.login_app_host
}

output "rp_app_host" {
  value = var.rp_app_host
}

output "auth0_origin" {
  description = "Self-managed custom domain origin the Worker proxies to"
  value       = auth0_custom_domain_verification.idp.origin_domain_name
}

output "cname_api_key" {
  value     = auth0_custom_domain_verification.idp.cname_api_key
  sensitive = true
}

output "login_app_client_id" {
  value = auth0_client.login_app.client_id
}

output "rp_app_client_id" {
  value = auth0_client.rp_app.client_id
}

output "bridge_client_id" {
  value = auth0_client.bridge.client_id
}

output "bridge_client_secret" {
  value     = auth0_client_credentials.bridge.client_secret
  sensitive = true
}
