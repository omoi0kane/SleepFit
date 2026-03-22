use super::OVR_CONTEXT;
use log::error;
use ovr_overlay as ovr;
use serde::Deserialize;
use std::sync::LazyLock;
use tokio::sync::Mutex;

const WAKE_OVERLAY_WIDTH_METERS: f32 = 1.0;
const WAKE_OVERLAY_SORT_ORDER: u32 = 210;
const WAKE_OVERLAY_TEXTURE_SIZE: u32 = 256;

static OVERLAY_HANDLE: LazyLock<Mutex<Option<ovr_overlay::overlay::OverlayHandle>>> =
    LazyLock::new(Default::default);
static OPACITY: LazyLock<Mutex<f64>> = LazyLock::new(|| Mutex::new(0.0));
static CONFIG: LazyLock<Mutex<WakeOverlayConfig>> =
    LazyLock::new(|| Mutex::new(WakeOverlayConfig::quest3_default()));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeOverlayConfig {
    pub hmd_profile: String,
    pub axis_scale_x: f64,
    pub axis_scale_y: f64,
    pub inner_radius: f64,
    pub outer_radius: f64,
    pub max_opacity: f64,
    pub base_opacity: f64,
    pub accent_opacity: f64,
    pub shape: f64,
    pub accent_shape: f64,
    pub center_floor: f64,
    pub color_r: u8,
    pub color_g: u8,
    pub color_b: u8,
}

impl WakeOverlayConfig {
    pub fn quest3_default() -> Self {
        Self {
            hmd_profile: "Quest 3".to_string(),
            axis_scale_x: 1.0,
            axis_scale_y: 1.0,
            inner_radius: 0.25,
            outer_radius: 0.95,
            max_opacity: 0.5,
            base_opacity: 0.32,
            accent_opacity: 0.18,
            shape: 1.2,
            accent_shape: 2.5,
            center_floor: 0.0,
            color_r: 255,
            color_g: 244,
            color_b: 232,
        }
    }

    fn sanitized(&self) -> Self {
        let max_opacity = self.max_opacity.clamp(0.01, 1.0);
        let inner_radius = self.inner_radius.clamp(0.0, 0.999);
        let outer_radius = self.outer_radius.clamp(inner_radius + 0.001, 2.0);
        Self {
            hmd_profile: self.hmd_profile.clone(),
            axis_scale_x: self.axis_scale_x.clamp(0.1, 4.0),
            axis_scale_y: self.axis_scale_y.clamp(0.1, 4.0),
            inner_radius,
            outer_radius,
            max_opacity,
            base_opacity: self.base_opacity.clamp(0.0, 1.0),
            accent_opacity: self.accent_opacity.clamp(0.0, 1.0),
            shape: self.shape.clamp(0.1, 8.0),
            accent_shape: self.accent_shape.clamp(0.1, 8.0),
            center_floor: self.center_floor.clamp(0.0, max_opacity),
            color_r: self.color_r,
            color_g: self.color_g,
            color_b: self.color_b,
        }
    }
}

pub async fn on_ovr_init(context: &ovr::Context) -> Result<(), String> {
    *OVERLAY_HANDLE.lock().await = None;
    let overlay_handle = match create_overlay(context).await {
        Ok(handle) => handle,
        Err(_) => return Err("Failed to create wake overlay".to_string()),
    };
    *OVERLAY_HANDLE.lock().await = Some(overlay_handle);
    Ok(())
}

pub async fn on_ovr_quit() {
    *OVERLAY_HANDLE.lock().await = None;
    *OPACITY.lock().await = 0.0;
}

pub async fn set_opacity(opacity: f64) {
    let opacity = opacity.clamp(0.0, 1.0);
    *OPACITY.lock().await = opacity;
    let mut context_guard = OVR_CONTEXT.lock().await;
    let context = match context_guard.as_mut() {
        Some(manager) => manager,
        None => return,
    };
    let mut manager = context.overlay_mngr();
    let overlay_handle_guard = OVERLAY_HANDLE.lock().await;
    let overlay_handle = match overlay_handle_guard.as_ref() {
        Some(handle) => handle,
        None => return,
    };
    if let Err(e) = manager.set_opacity(*overlay_handle, opacity as f32) {
        error!("[Core] Failed to set wake overlay opacity: {e}");
    };
}

pub async fn set_config(config: WakeOverlayConfig) {
    let config = config.sanitized();
    *CONFIG.lock().await = config.clone();
    let mut context_guard = OVR_CONTEXT.lock().await;
    let context = match context_guard.as_mut() {
        Some(manager) => manager,
        None => return,
    };
    let mut manager = context.overlay_mngr();
    let overlay_handle_guard = OVERLAY_HANDLE.lock().await;
    let overlay_handle = match overlay_handle_guard.as_ref() {
        Some(handle) => handle,
        None => return,
    };
    if let Err(e) = apply_texture(&mut manager, *overlay_handle, &config) {
        error!("[Core] Failed to update wake overlay texture: {e}");
    }
}

async fn create_overlay(
    context: &ovr_overlay::Context,
) -> Result<ovr_overlay::overlay::OverlayHandle, ()> {
    let mut manager = context.overlay_mngr();
    let overlay = match manager.create_overlay(
        "com.fleabane.sleepfit:WakeOverlay",
        "SleepFit Wake Overlay",
    ) {
        Ok(handle) => handle,
        Err(_) => return Err(()),
    };
    let config = CONFIG.lock().await.clone();
    if let Err(e) = apply_texture(&mut manager, overlay, &config) {
        error!("[Core] Failed to set wake overlay image data: {e}");
        return Err(());
    }
    let transformation_matrix =
        ovr_overlay::pose::Matrix3x4([[1., 0., 0., 0.], [0., 1., 0., 0.], [0., 0., 1., -0.15]]);
    if let Err(e) = manager.set_transform_tracked_device_relative(
        overlay,
        ovr_overlay::TrackedDeviceIndex::new(0).unwrap(),
        &transformation_matrix,
    ) {
        error!("[Core] Failed to set wake overlay transform: {e}");
        return Err(());
    }
    if let Err(e) = manager.set_sort_order(overlay, WAKE_OVERLAY_SORT_ORDER) {
        error!("[Core] Failed to set wake overlay sort order: {e}");
        return Err(());
    }
    if let Err(e) = manager.set_width(overlay, WAKE_OVERLAY_WIDTH_METERS) {
        error!("[Core] Failed to set wake overlay width: {e}");
        return Err(());
    }
    let opacity = *OPACITY.lock().await;
    if let Err(e) = manager.set_opacity(overlay, opacity as f32) {
        error!("[Core] Failed to set wake overlay opacity: {e}");
        return Err(());
    }
    if let Err(e) = manager.set_visibility(overlay, true) {
        error!("[Core] Failed to set wake overlay visibility: {e}");
        return Err(());
    }
    Ok(overlay)
}

fn apply_texture(
    manager: &mut ovr_overlay::overlay::OverlayManager,
    overlay: ovr_overlay::overlay::OverlayHandle,
    config: &WakeOverlayConfig,
) -> Result<(), String> {
    let image = generate_overlay_texture(config);
    manager
        .set_raw_data(
        overlay,
        image.as_slice(),
        WAKE_OVERLAY_TEXTURE_SIZE as usize,
        WAKE_OVERLAY_TEXTURE_SIZE as usize,
        4,
    )
        .map_err(|e| e.to_string())
}

fn generate_overlay_texture(config: &WakeOverlayConfig) -> Vec<u8> {
    let mut texture =
        Vec::with_capacity((WAKE_OVERLAY_TEXTURE_SIZE * WAKE_OVERLAY_TEXTURE_SIZE * 4) as usize);
    let half_size = (WAKE_OVERLAY_TEXTURE_SIZE - 1) as f64 / 2.0;
    let max_opacity = config.max_opacity.max(0.0001);
    let axis_scale_x = config.axis_scale_x.max(0.0001);
    let axis_scale_y = config.axis_scale_y.max(0.0001);

    for y in 0..WAKE_OVERLAY_TEXTURE_SIZE {
        for x in 0..WAKE_OVERLAY_TEXTURE_SIZE {
            let normalized_x = (x as f64 - half_size) / half_size;
            let normalized_y = (y as f64 - half_size) / half_size;
            let radius = ((normalized_x / axis_scale_x).powi(2)
                + (normalized_y / axis_scale_y).powi(2))
            .sqrt();
            let t = saturate((radius - config.inner_radius) / (config.outer_radius - config.inner_radius));
            let g = smootherstep(t);
            let base = config.base_opacity * g.powf(config.shape);
            let accent = config.accent_opacity * t.powf(config.accent_shape);
            let alpha_computed = (base + accent).min(max_opacity);
            let alpha = (config.center_floor
                + alpha_computed * (1.0 - config.center_floor / max_opacity))
            .clamp(0.0, max_opacity);
            let alpha_normalized = (alpha / max_opacity).clamp(0.0, 1.0);
            let alpha_u8 = (alpha_normalized * 255.0).round().clamp(0.0, 255.0) as u8;
            texture.extend_from_slice(&[
                config.color_r,
                config.color_g,
                config.color_b,
                alpha_u8,
            ]);
        }
    }

    texture
}

fn saturate(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

fn smootherstep(t: f64) -> f64 {
    let t = saturate(t);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}
