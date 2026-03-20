<script lang="ts">
	import ipc from '$lib/services/ipc.service';
	import BrightnessSlider from './BrightnessSlider.svelte';
	import throttle from 'just-throttle';
	import { blurFly } from '$lib/utils/transitions';
	import { t } from '$lib/translations';

	let animationSpeed = 300;
	let flyYTransform = 30;
	// State
	let { state } = ipc;
	$: brightnessState = $state.brightnessState;
	$: volumeState = $state.volumeState;
</script>

<div class="sliders-container" style:height={brightnessState?.advancedMode ? '21em' : '14em'}>
	{#if !!brightnessState}
		{#if !brightnessState?.advancedMode}
			<div
				class="sliders-stack"
				transition:blurFly={{
					duration: animationSpeed,
					y: flyYTransform
				}}
			>
				<BrightnessSlider
					label={$t('t.overlay.brightness.simple')}
					value={brightnessState.brightness}
					min={5}
					isTransitioning={brightnessState.brightnessTransitioning}
					transitionTarget={brightnessState.brightnessTransitionTarget}
					onValueChange={throttle((value) => ipc.setBrightness('SIMPLE', value), 16, {
						leading: true,
						trailing: true
					})}
				/>
				class="volume-slider"
			>
				<BrightnessSlider
					label="音量 (基準比)"
					value={volumeState?.value ?? 100}
					min={0}
					max={100}
					disabled={!volumeState?.enabled}
					isTransitioning={volumeState?.transitioning ?? false}
					transitionTarget={volumeState?.transitionTarget ?? 100}
					onValueChange={throttle((value) => ipc.setRelativeVolume(value), 16, {
						leading: true,
						trailing: true
					})}
				/>
				<p class="volume-slider-note">100% = このセッションの基準音量</p>
			</div>
		{:else}
			<div
				class="sliders-stack"
				transition:blurFly={{
					duration: animationSpeed,
					y: flyYTransform
				}}
			>
				<BrightnessSlider
					label={$t('t.overlay.brightness.software')}
					min={5}
					value={brightnessState.softwareBrightness}
					isTransitioning={brightnessState.softwareBrightnessTransitioning}
					transitionTarget={brightnessState.softwareBrightnessTransitionTarget}
					onValueChange={throttle((value) => ipc.setBrightness('SOFTWARE', value), 16, {
						leading: true,
						trailing: true
					})}
				/>
				<BrightnessSlider
					label={$t('t.overlay.brightness.hardware')}
					min={brightnessState.hardwareMinBrightness}
					max={brightnessState.hardwareMaxBrightness}
					value={brightnessState.hardwareBrightness}
					disabled={!brightnessState.hardwareBrightnessAvailable}
					isTransitioning={brightnessState.hardwareBrightnessTransitioning}
					transitionTarget={brightnessState.hardwareBrightnessTransitionTarget}
					onValueChange={throttle((value) => ipc.setBrightness('HARDWARE', value), 16, {
						leading: true,
						trailing: true
					})}
				/>
				<div class="volume-slider">
					<BrightnessSlider
						label="音量 (基準比)"
						value={volumeState?.value ?? 100}
						min={0}
						max={100}
						disabled={!volumeState?.enabled}
						isTransitioning={volumeState?.transitioning ?? false}
						transitionTarget={volumeState?.transitionTarget ?? 100}
						onValueChange={throttle((value) => ipc.setRelativeVolume(value), 16, {
							leading: true,
							trailing: true
						})}
					/>
					<p class="volume-slider-note">100% = このセッションの基準音量</p>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style lang="scss">
	.sliders-container {
		position: relative;

		& > div {
			position: absolute;
			top: 0;
			left: 0;
			width: 100%;
		}
	}

	.sliders-stack {
		display: flex;
		flex-direction: column;
	}

	.volume-slider {
		margin-top: 1rem;
	}

	.volume-slider-note {
		@apply mt-2 text-center text-white text-opacity-70 text-lg;
	}
</style>
