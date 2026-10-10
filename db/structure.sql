SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: secret_access_events_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.secret_access_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'secret_access_events is append-only';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ar_internal_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ar_internal_metadata (
    key character varying NOT NULL,
    value character varying,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL
);


--
-- Name: connection_secret_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connection_secret_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_connection_id uuid NOT NULL,
    vault_secret_id uuid NOT NULL,
    purpose character varying NOT NULL,
    created_at timestamp(6) without time zone NOT NULL,
    workspace_id uuid NOT NULL
);


--
-- Name: integration_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    provider_key character varying NOT NULL,
    auth_method character varying NOT NULL,
    adapter_key character varying NOT NULL,
    provider_account_ref character varying,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    access_expires_at timestamp(6) without time zone,
    refresh_after timestamp(6) without time zone,
    last_refreshed_at timestamp(6) without time zone,
    refresh_lease_expires_at timestamp(6) without time zone,
    refresh_generation integer DEFAULT 0 NOT NULL,
    last_error_code character varying,
    reauth_required_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    token_url character varying,
    CONSTRAINT integration_connections_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'refreshing'::character varying, 'reauth_required'::character varying, 'revoked'::character varying, 'error'::character varying])::text[]))),
    CONSTRAINT integration_connections_token_url_https CHECK (((token_url IS NULL) OR ((token_url)::text ~~ 'https://%'::text)))
);


--
-- Name: rotation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rotation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_connection_id uuid,
    vault_secret_id uuid,
    result_version_id uuid,
    operation character varying NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    idempotency_key character varying NOT NULL,
    run_after timestamp(6) without time zone NOT NULL,
    started_at timestamp(6) without time zone,
    completed_at timestamp(6) without time zone,
    error_code character varying,
    lease_token character varying,
    lease_expires_at timestamp(6) without time zone,
    correlation_id character varying,
    created_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT rotation_runs_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'running'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: secret_access_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_access_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid,
    actor_client_id uuid,
    vault_secret_id uuid,
    secret_version_id uuid,
    action character varying NOT NULL,
    outcome character varying DEFAULT 'success'::character varying NOT NULL,
    reason_code character varying,
    request_id character varying,
    source_ip character varying,
    created_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT secret_access_events_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['success'::character varying, 'denied'::character varying, 'error'::character varying])::text[])))
);


--
-- Name: secret_access_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_access_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_client_id uuid NOT NULL,
    vault_secret_id uuid NOT NULL,
    permissions character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    workspace_id uuid NOT NULL,
    CONSTRAINT secret_access_grants_permissions_check CHECK (((cardinality(permissions) > 0) AND (permissions <@ ARRAY['metadata:read'::character varying, 'value:read'::character varying, 'version:create'::character varying, 'rotate'::character varying, 'revoke'::character varying, 'connection:refresh'::character varying, 'audit:read'::character varying])))
);


--
-- Name: secret_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_leases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vault_secret_id uuid NOT NULL,
    service_client_id uuid NOT NULL,
    granted_permissions character varying[] DEFAULT '{}'::character varying[] NOT NULL,
    issued_at timestamp(6) without time zone NOT NULL,
    expires_at timestamp(6) without time zone NOT NULL,
    revoked_at timestamp(6) without time zone,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT secret_leases_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'expired'::character varying, 'revoked'::character varying])::text[])))
);


--
-- Name: secret_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vault_secret_id uuid NOT NULL,
    version_number integer NOT NULL,
    ciphertext text NOT NULL,
    encrypted_data_key text NOT NULL,
    kms_key_ref character varying NOT NULL,
    crypto_scheme character varying NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    created_by character varying NOT NULL,
    activated_at timestamp(6) without time zone NOT NULL,
    retired_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT secret_versions_number_check CHECK ((version_number > 0)),
    CONSTRAINT secret_versions_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'retired'::character varying, 'destroyed'::character varying])::text[])))
);


--
-- Name: service_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.service_clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    public_id character varying NOT NULL,
    name character varying NOT NULL,
    client_type character varying NOT NULL,
    credential_digest character varying NOT NULL,
    credential_prefix character varying NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    expires_at timestamp(6) without time zone,
    last_used_at timestamp(6) without time zone,
    revoked_at timestamp(6) without time zone,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT service_clients_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'revoked'::character varying, 'expired'::character varying])::text[]))),
    CONSTRAINT service_clients_type_check CHECK (((client_type)::text = ANY ((ARRAY['bot'::character varying, 'app'::character varying, 'gateway'::character varying, 'cli'::character varying, 'mcp'::character varying, 'worker'::character varying])::text[])))
);


--
-- Name: vault_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    path character varying NOT NULL,
    name character varying NOT NULL,
    kind character varying NOT NULL,
    classification character varying DEFAULT 'confidential'::character varying NOT NULL,
    environment character varying DEFAULT 'production'::character varying NOT NULL,
    provider character varying,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    expires_at timestamp(6) without time zone,
    revoked_at timestamp(6) without time zone,
    current_version_id uuid,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT vault_secrets_classification_check CHECK (((classification)::text = ANY ((ARRAY['public'::character varying, 'internal'::character varying, 'confidential'::character varying, 'restricted'::character varying])::text[]))),
    CONSTRAINT vault_secrets_kind_check CHECK (((kind)::text = ANY ((ARRAY['api_key'::character varying, 'access_token'::character varying, 'refresh_token'::character varying, 'client_secret'::character varying, 'totp_seed'::character varying, 'private_key'::character varying, 'certificate'::character varying, 'connection_string'::character varying, 'public_key'::character varying])::text[]))),
    CONSTRAINT vault_secrets_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'rotating'::character varying, 'revoked'::character varying, 'expired'::character varying, 'retired'::character varying])::text[])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug character varying NOT NULL,
    name character varying NOT NULL,
    status character varying DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp(6) without time zone NOT NULL,
    updated_at timestamp(6) without time zone NOT NULL,
    CONSTRAINT workspaces_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: ar_internal_metadata ar_internal_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ar_internal_metadata
    ADD CONSTRAINT ar_internal_metadata_pkey PRIMARY KEY (key);


--
-- Name: connection_secret_bindings connection_secret_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_secret_bindings
    ADD CONSTRAINT connection_secret_bindings_pkey PRIMARY KEY (id);


--
-- Name: integration_connections integration_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT integration_connections_pkey PRIMARY KEY (id);


--
-- Name: rotation_runs rotation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rotation_runs
    ADD CONSTRAINT rotation_runs_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: secret_access_events secret_access_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_access_events
    ADD CONSTRAINT secret_access_events_pkey PRIMARY KEY (id);


--
-- Name: secret_access_grants secret_access_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_access_grants
    ADD CONSTRAINT secret_access_grants_pkey PRIMARY KEY (id);


--
-- Name: secret_leases secret_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_leases
    ADD CONSTRAINT secret_leases_pkey PRIMARY KEY (id);


--
-- Name: secret_versions secret_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_versions
    ADD CONSTRAINT secret_versions_pkey PRIMARY KEY (id);


--
-- Name: service_clients service_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_clients
    ADD CONSTRAINT service_clients_pkey PRIMARY KEY (id);


--
-- Name: vault_secrets vault_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT vault_secrets_pkey PRIMARY KEY (id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: idx_on_service_client_id_vault_secret_id_5b63351e77; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_on_service_client_id_vault_secret_id_5b63351e77 ON public.secret_access_grants USING btree (service_client_id, vault_secret_id);


--
-- Name: index_bindings_on_connection_and_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_bindings_on_connection_and_purpose ON public.connection_secret_bindings USING btree (integration_connection_id, purpose);


--
-- Name: index_connection_secret_bindings_on_vault_secret_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_connection_secret_bindings_on_vault_secret_id ON public.connection_secret_bindings USING btree (vault_secret_id);


--
-- Name: index_integration_connections_on_id_and_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_integration_connections_on_id_and_workspace_id ON public.integration_connections USING btree (id, workspace_id);


--
-- Name: index_integration_connections_on_status_and_refresh_after; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_integration_connections_on_status_and_refresh_after ON public.integration_connections USING btree (status, refresh_after);


--
-- Name: index_integration_connections_on_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_integration_connections_on_workspace_id ON public.integration_connections USING btree (workspace_id);


--
-- Name: index_rotation_runs_on_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_rotation_runs_on_idempotency_key ON public.rotation_runs USING btree (idempotency_key);


--
-- Name: index_rotation_runs_on_integration_connection_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_rotation_runs_on_integration_connection_id ON public.rotation_runs USING btree (integration_connection_id);


--
-- Name: index_rotation_runs_on_result_version_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_rotation_runs_on_result_version_id ON public.rotation_runs USING btree (result_version_id);


--
-- Name: index_rotation_runs_on_vault_secret_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_rotation_runs_on_vault_secret_id ON public.rotation_runs USING btree (vault_secret_id);


--
-- Name: index_secret_access_events_on_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_secret_access_events_on_action ON public.secret_access_events USING btree (action);


--
-- Name: index_secret_access_events_on_vault_secret_id_and_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_secret_access_events_on_vault_secret_id_and_created_at ON public.secret_access_events USING btree (vault_secret_id, created_at);


--
-- Name: index_secret_access_events_on_workspace_id_and_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_secret_access_events_on_workspace_id_and_created_at ON public.secret_access_events USING btree (workspace_id, created_at);


--
-- Name: index_secret_access_grants_on_vault_secret_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_secret_access_grants_on_vault_secret_id ON public.secret_access_grants USING btree (vault_secret_id);


--
-- Name: index_secret_leases_on_service_client_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_secret_leases_on_service_client_id ON public.secret_leases USING btree (service_client_id);


--
-- Name: index_secret_leases_on_vault_secret_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_secret_leases_on_vault_secret_id ON public.secret_leases USING btree (vault_secret_id);


--
-- Name: index_secret_versions_on_id_and_vault_secret_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_secret_versions_on_id_and_vault_secret_id ON public.secret_versions USING btree (id, vault_secret_id);


--
-- Name: index_secret_versions_on_vault_secret_id_and_version_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_secret_versions_on_vault_secret_id_and_version_number ON public.secret_versions USING btree (vault_secret_id, version_number);


--
-- Name: index_secret_versions_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_secret_versions_one_active ON public.secret_versions USING btree (vault_secret_id) WHERE ((status)::text = 'active'::text);


--
-- Name: index_service_clients_on_credential_digest; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_service_clients_on_credential_digest ON public.service_clients USING btree (credential_digest);


--
-- Name: index_service_clients_on_id_and_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_service_clients_on_id_and_workspace_id ON public.service_clients USING btree (id, workspace_id);


--
-- Name: index_service_clients_on_public_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_service_clients_on_public_id ON public.service_clients USING btree (public_id);


--
-- Name: index_service_clients_on_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_service_clients_on_workspace_id ON public.service_clients USING btree (workspace_id);


--
-- Name: index_service_clients_on_workspace_id_and_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_service_clients_on_workspace_id_and_name ON public.service_clients USING btree (workspace_id, name);


--
-- Name: index_vault_secrets_on_id_and_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_vault_secrets_on_id_and_workspace_id ON public.vault_secrets USING btree (id, workspace_id);


--
-- Name: index_vault_secrets_on_workspace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX index_vault_secrets_on_workspace_id ON public.vault_secrets USING btree (workspace_id);


--
-- Name: index_vault_secrets_on_workspace_id_and_path; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_vault_secrets_on_workspace_id_and_path ON public.vault_secrets USING btree (workspace_id, path);


--
-- Name: index_workspaces_on_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX index_workspaces_on_slug ON public.workspaces USING btree (slug);


--
-- Name: secret_access_events secret_access_events_no_mutation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER secret_access_events_no_mutation BEFORE DELETE OR UPDATE ON public.secret_access_events FOR EACH ROW EXECUTE FUNCTION public.secret_access_events_append_only();


--
-- Name: connection_secret_bindings fk_connection_secret_bindings_integration_connection_id_same_wo; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_secret_bindings
    ADD CONSTRAINT fk_connection_secret_bindings_integration_connection_id_same_wo FOREIGN KEY (integration_connection_id, workspace_id) REFERENCES public.integration_connections(id, workspace_id);


--
-- Name: connection_secret_bindings fk_connection_secret_bindings_vault_secret_id_same_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_secret_bindings
    ADD CONSTRAINT fk_connection_secret_bindings_vault_secret_id_same_workspace FOREIGN KEY (vault_secret_id, workspace_id) REFERENCES public.vault_secrets(id, workspace_id);


--
-- Name: secret_access_grants fk_rails_2a8cdc2896; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_access_grants
    ADD CONSTRAINT fk_rails_2a8cdc2896 FOREIGN KEY (service_client_id) REFERENCES public.service_clients(id);


--
-- Name: rotation_runs fk_rails_4b29a61f2c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rotation_runs
    ADD CONSTRAINT fk_rails_4b29a61f2c FOREIGN KEY (result_version_id) REFERENCES public.secret_versions(id);


--
-- Name: rotation_runs fk_rails_8802d89de3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rotation_runs
    ADD CONSTRAINT fk_rails_8802d89de3 FOREIGN KEY (vault_secret_id) REFERENCES public.vault_secrets(id);


--
-- Name: integration_connections fk_rails_8b0d2f5701; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_connections
    ADD CONSTRAINT fk_rails_8b0d2f5701 FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: rotation_runs fk_rails_96f8303d79; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rotation_runs
    ADD CONSTRAINT fk_rails_96f8303d79 FOREIGN KEY (integration_connection_id) REFERENCES public.integration_connections(id);


--
-- Name: connection_secret_bindings fk_rails_9a4769604a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_secret_bindings
    ADD CONSTRAINT fk_rails_9a4769604a FOREIGN KEY (integration_connection_id) REFERENCES public.integration_connections(id);


--
-- Name: vault_secrets fk_rails_a96fdebebd; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT fk_rails_a96fdebebd FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: connection_secret_bindings fk_rails_b2e1ee3496; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_secret_bindings
    ADD CONSTRAINT fk_rails_b2e1ee3496 FOREIGN KEY (vault_secret_id) REFERENCES public.vault_secrets(id);


--
-- Name: secret_versions fk_rails_c13434c0fd; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_versions
    ADD CONSTRAINT fk_rails_c13434c0fd FOREIGN KEY (vault_secret_id) REFERENCES public.vault_secrets(id);


--
-- Name: secret_leases fk_rails_d0b20dac10; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_leases
    ADD CONSTRAINT fk_rails_d0b20dac10 FOREIGN KEY (vault_secret_id) REFERENCES public.vault_secrets(id);


--
-- Name: secret_access_grants fk_rails_d0c80d3dde; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_access_grants
    ADD CONSTRAINT fk_rails_d0c80d3dde FOREIGN KEY (vault_secret_id) REFERENCES public.vault_secrets(id);


--
-- Name: service_clients fk_rails_f0cb459c23; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.service_clients
    ADD CONSTRAINT fk_rails_f0cb459c23 FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id);


--
-- Name: secret_leases fk_rails_fac377449a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_leases
    ADD CONSTRAINT fk_rails_fac377449a FOREIGN KEY (service_client_id) REFERENCES public.service_clients(id);


--
-- Name: secret_access_grants fk_secret_access_grants_service_client_id_same_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_access_grants
    ADD CONSTRAINT fk_secret_access_grants_service_client_id_same_workspace FOREIGN KEY (service_client_id, workspace_id) REFERENCES public.service_clients(id, workspace_id);


--
-- Name: secret_access_grants fk_secret_access_grants_vault_secret_id_same_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_access_grants
    ADD CONSTRAINT fk_secret_access_grants_vault_secret_id_same_workspace FOREIGN KEY (vault_secret_id, workspace_id) REFERENCES public.vault_secrets(id, workspace_id);


--
-- Name: vault_secrets fk_vault_secrets_current_version_same_secret; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_secrets
    ADD CONSTRAINT fk_vault_secrets_current_version_same_secret FOREIGN KEY (current_version_id, id) REFERENCES public.secret_versions(id, vault_secret_id);


--
-- PostgreSQL database dump complete
--

SET search_path TO "$user", public;

INSERT INTO "schema_migrations" (version) VALUES
('20261011000010'),
('20261011000009'),
('20261011000008'),
('20261011000007'),
('20261011000006'),
('20261011000005'),
('20261011000004'),
('20261011000003'),
('20261011000002'),
('20261011000001');

