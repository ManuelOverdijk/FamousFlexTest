import Famous from 'famous'
import Engine from 'famous/core/Engine'
import Context from 'famous/core/Context'
import Surface from 'famous/core/Surface'
import ContainerSurface from 'famous/surfaces/ContainerSurface'
import Transform from 'famous/core/Transform'

import LayoutController from 'famous-flex/src/LayoutController'
import ScrollController from 'famous-flex/src/ScrollController'
import CollectionLayout from 'famous-flex/src/layouts/CollectionLayout'
import FlexScrollView from 'famous-flex/src/FlexScrollView'
import ListLayout from 'famous-flex/src/layouts/ListLayout'
import WheelLayout from 'famous-flex/src/layouts/WheelLayout'
import Utility from 'famous/utilities/Utility'
import Modifier from 'famous/core/Modifier'
import RenderNode from 'famous/core/RenderNode'

export default
class AppView {

    constructor(){
        this.mainContext = Engine.createContext();

        this._createLayout();
        this._fillLayout();
    }

    /**
     * Create the main AppView layout
     * @private
     */
    _createLayout(){

        /* Vertical ScrollView */
        this.scrollView = new FlexScrollView({
            layout: ListLayout,
            flow: true,
            direction:1,
            /* layoutOptions for the BizboardLayout */
            layoutOptions: {
                itemSize: 400
            }
        });

        /* Horizontal ScrollView */
        this.horizontalScrollView = new FlexScrollView({
            layout: ListLayout,
            flow: true,
            mouseMove: true,
            direction:0,
            touchMoveDirectionThresshold: 0.5,
            layoutOptions: {
                itemSize: 400
            },
            enabled: true
        });

        this.horzContainer = new ContainerSurface();
        this.horzContainer.add(this.horizontalScrollView);
        this.horzContainer.pipe(this.horizontalScrollView);

        this.container = new ContainerSurface();
        this.container.add(this.scrollView);
        this.container.pipe(this.scrollView);

        this.mainContext.setPerspective(500);
        this.mainContext.add(this.container);

    }

    /**
     * Fill the vertical and horizontal scrollviews with test surfaces
     * @private
     */
    _fillLayout(){
        this.scrollView.push(this. _createCell("orange"), {opacity: 0});
        this.scrollView.push(this.horzContainer);
        this.scrollView.push(this._createCell("black"), {opacity: 0});
        this.scrollView.push(this._createCell("orange"), {opacity: 0});
        this.scrollView.push(this._createCell("blue"), {opacity: 0});
        this.scrollView.push(this._createCell("green"),{opacity: 0});
        this.scrollView.push(this._createCell("cyan"), {opacity: 0});
        this.scrollView.push(this._createCell("orange"),{opacity: 0});
        this.scrollView.push(this._createCell("red"), {opacity: 0});
        this.scrollView.push(this._createCell("black"),{opacity: 0});
        this.scrollView.push(this._createCell("blue"), {opacity: 0});

        this.horizontalScrollView.push(this._createCell2("hor1","red"));
        this.horizontalScrollView.push(this._createCell2("hor2","orange"));
        this.horizontalScrollView.push(this._createCell2("hor1","red"));
        this.horizontalScrollView.push(this._createCell2("hor2","orange"));
        this.horizontalScrollView.push(this._createCell2("hor1","red"));
        this.horizontalScrollView.push(this._createCell2("hor2","orange"));
        this.horizontalScrollView.push(this._createCell2("hor1","red"));
        this.horizontalScrollView.push(this._createCell2("hor2","orange"));


    }

    _createCell(color) {
        return new Surface({
            content: 'my section',
            size: [undefined,undefined],
            //size: [750, 1334],
            properties: {
                "background": color
            }
        });
    }

    /**
     *
     * @param {string} title
     * @param {string} color
     * @returns {RenderNode}
     * @private
     */
    _createCell2(title, color) {
        let surface = new Surface({
            content: title,
            size: [undefined,undefined],
            properties: {
                "background": color
            }
        });
        return surface;
    }

}

