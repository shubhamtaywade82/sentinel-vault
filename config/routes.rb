Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  # Paths mirror the existing Next.js API so the UI can switch backends unchanged.
  namespace :api do
    namespace :v1 do
      get "health/live", to: "health#live"
      get "health/ready", to: "health#ready"
      get "me", to: "me#show"

      resources :workspaces, only: %i[index create]
      resources :grants, only: :index
      get "audit_events/export", to: "audit_events#export"
      resources :audit_events, only: :index

      scope "dashboard", controller: "dashboard" do
        %w[stats provider-health client-preview compliance expiring-leases audit-activity anomalies].each do |name|
          get name, action: name.underscore
        end
      end
      post "dashboard/remediate", to: "dashboard/remediations#create"

      resources :secrets, only: %i[index show create] do
        scope module: :secrets do
          resources :versions, only: %i[index create]
          resources :events, only: :index
          resources :leases, only: %i[index create]
          resource :usage, only: :show
          resource :reveal, only: :create
          resource :diff, only: :create
          resource :rotation, only: :create, path: "rotate"
          resource :revocation, only: :create, path: "revoke"
        end
      end

      resources :connections, only: %i[index create] do
        scope module: :connections do
          resource :status, only: :show
          resource :credential, only: :create
          resource :revocation, only: :create, path: "revoke"
          resource :refresh, only: :create
          resource :reauthorization, only: :create, path: "reauthorize"
          resource :recovery, only: :create, path: "recover"
        end
      end

      resources :rotation_runs, only: %i[index show]
      resources :leases, only: %i[index destroy]
      post "internal/watchdog", to: "internal/watchdogs#create"

      namespace :admin do
        resources :service_clients, only: %i[index create] do
          member do
            post :rotate_credential
            post :revoke
          end
        end
        resources :grants, only: %i[create destroy]
      end
    end
  end
end
